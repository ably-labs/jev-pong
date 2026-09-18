import { APICallError } from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DecideRequest, DecisionState } from '../game/types';
import { DEFAULT_TIMEOUT_MS, decide, mapDecideError } from './index';

vi.mock('./jev', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./jev')>()),
  decideWithJev: vi.fn(),
}));
vi.mock('./llm', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./llm')>()),
  decideWithLlm: vi.fn(),
}));

const { decideWithJev } = await import('./jev');
const { decideWithLlm } = await import('./llm');
const jev = vi.mocked(decideWithJev);
const llm = vi.mocked(decideWithLlm);

const STATE: DecisionState = {
  court: { w: 160, h: 100 },
  ball: { x: 80, y: 42, vx: 26.67, vy: 8 },
  paddle: { y: 30, h: 20 },
  interceptY: 66,
  dir: 'toward',
};

function request(overrides: Partial<DecideRequest> = {}): DecideRequest {
  return { model: 'jev', state: STATE, mode: 'demo', ...overrides };
}

function apiError(statusCode: number, message = 'gateway said no', responseBody?: string) {
  return new APICallError({
    message,
    url: 'https://ai-gateway.vercel.sh/v1/x',
    requestBodyValues: {},
    statusCode,
    responseBody,
  });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('decide — routing', () => {
  it('sends the Jev lane to the evaluate decider', async () => {
    jev.mockResolvedValue({ move: 'down', latencyMs: 412.7 });
    const result = await decide(request());

    expect(result).toEqual({ ok: true, move: 'down', latencyMs: 413, model: 'jev' });
    expect(jev).toHaveBeenCalledTimes(1);
    expect(llm).not.toHaveBeenCalled();
  });

  it('sends an LLM lane to the structured decider with its Gateway id', async () => {
    llm.mockResolvedValue({ move: 'up', latencyMs: 1500 });
    const result = await decide(request({ model: 'haiku' }));

    expect(result).toEqual({ ok: true, move: 'up', latencyMs: 1500, model: 'haiku' });
    expect(llm).toHaveBeenCalledWith('anthropic/claude-haiku-4.5', STATE, expect.anything());
    expect(jev).not.toHaveBeenCalled();
  });
});

describe('decide — rejections', () => {
  it('rejects an unknown model as a bad request', async () => {
    const result = await decide(request({ model: 'llama' as DecideRequest['model'] }));
    expect(result).toEqual({ ok: false, error: 'bad_request', message: expect.stringContaining('llama') });
    expect(jev).not.toHaveBeenCalled();
  });

  it.each(['human', 'wall', 'mock'] as const)('rejects the local decider "%s"', async (model) => {
    const result = await decide(request({ model }));
    expect(result).toMatchObject({ ok: false, error: 'bad_request' });
    expect(jev).not.toHaveBeenCalled();
    expect(llm).not.toHaveBeenCalled();
  });

  it.each(['haiku', 'gpt', 'gemini'] as const)('refuses to let you play "%s"', async (model) => {
    const result = await decide(request({ model, mode: 'play' }));
    expect(result).toMatchObject({ ok: false, error: 'model_not_allowed' });
    expect(llm).not.toHaveBeenCalled();
  });

  it('allows Jev in play mode', async () => {
    jev.mockResolvedValue({ move: 'stay', latencyMs: 300 });
    await expect(decide(request({ mode: 'play' }))).resolves.toMatchObject({ ok: true });
  });
});

describe('decide — failures from the model call', () => {
  it('reports a 402 as out of credits', async () => {
    jev.mockRejectedValue(apiError(402, 'Payment required'));
    await expect(decide(request())).resolves.toEqual({
      ok: false,
      error: 'out_of_credits',
      message: expect.stringContaining('budget'),
    });
  });

  it('reports a quota_for_entity_exceeded body as out of credits', async () => {
    jev.mockRejectedValue(apiError(400, 'Bad request', '{"error":{"type":"quota_for_entity_exceeded"}}'));
    await expect(decide(request())).resolves.toMatchObject({ ok: false, error: 'out_of_credits' });
  });

  it('reports a 429 as rate limited', async () => {
    llm.mockRejectedValue(apiError(429, 'Too many requests'));
    await expect(decide(request({ model: 'gpt' }))).resolves.toMatchObject({
      ok: false,
      error: 'rate_limited',
    });
  });

  it('reports anything else as a model error with a short, safe message', async () => {
    jev.mockRejectedValue(new Error('boom\n  at somewhere.ts:1:1\n'.repeat(40)));
    const result = await decide(request());
    expect(result).toMatchObject({ ok: false, error: 'model_error' });
    if (result.ok) expect.unreachable('expected a failure');
    expect(result.message.length).toBeLessThanOrEqual(200);
    expect(result.message).not.toContain('\n');
  });

  it('never returns a key-shaped string in the message', async () => {
    jev.mockRejectedValue(new Error('auth failed for sk-abcdefghijklmnopqrstuvwxyz'));
    const result = await decide(request());
    if (result.ok) expect.unreachable('expected a failure');
    expect(result.message).toContain('[redacted]');
    expect(result.message).not.toContain('abcdefghijklmnop');
  });
});

describe('decide — cancellation', () => {
  it('aborts the model call once the timeout passes', async () => {
    jev.mockImplementation((_state, opts) =>
      new Promise((_resolve, reject) => {
        opts?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }),
    );

    const result = await decide(request(), { timeoutMs: 20 });
    expect(result).toEqual({
      ok: false,
      error: 'model_error',
      message: 'Timed out after 20ms.',
    });
  });

  it('reports a caller-cancelled call without blaming the model', async () => {
    const controller = new AbortController();
    jev.mockImplementation((_state, opts) =>
      new Promise((_resolve, reject) => {
        opts?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }),
    );

    const pending = decide(request(), { signal: controller.signal });
    controller.abort();
    await expect(pending).resolves.toEqual({
      ok: false,
      error: 'model_error',
      message: 'Cancelled.',
    });
  });

  it('defaults to a 20 second ceiling', () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(20_000);
  });
});

describe('mapDecideError', () => {
  it('maps a 402 APICallError', () => {
    expect(mapDecideError(apiError(402)).error).toBe('out_of_credits');
  });

  it('maps a 429 APICallError', () => {
    expect(mapDecideError(apiError(429)).error).toBe('rate_limited');
  });

  it('maps a quota_for_entity_exceeded message', () => {
    expect(mapDecideError(new Error('quota_for_entity_exceeded')).error).toBe('out_of_credits');
  });

  it('maps a duck-typed gateway error with a status code', () => {
    expect(mapDecideError({ statusCode: 429, message: 'slow down' }).error).toBe('rate_limited');
  });

  it('falls back to model_error', () => {
    expect(mapDecideError(new Error('socket hang up'))).toEqual({
      ok: false,
      error: 'model_error',
      message: 'socket hang up',
    });
  });

  it('never returns an empty message', () => {
    expect(mapDecideError(new Error('')).message).toBeTruthy();
    expect(mapDecideError(undefined).message).toBeTruthy();
  });
});

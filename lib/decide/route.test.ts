/** Covers app/api/decide/route.ts. Lives here because lib/decide owns these tests. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DecideResponse, DecisionState } from '../game/types';

vi.mock('./jev', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./jev')>()),
  decideWithJev: vi.fn(),
}));
vi.mock('./llm', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./llm')>()),
  decideWithLlm: vi.fn(),
}));

const { POST } = await import('../../app/api/decide/route');
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

function post(body: unknown): Request {
  return new Request('http://localhost/api/decide', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function call(body: unknown): Promise<{ status: number; body: DecideResponse; cache: string | null }> {
  const response = await POST(post(body));
  return {
    status: response.status,
    body: (await response.json()) as DecideResponse,
    cache: response.headers.get('cache-control'),
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/decide', () => {
  it('returns 200 and the move when the model answers', async () => {
    jev.mockResolvedValue({ move: 'down', latencyMs: 402.4 });
    const result = await call({ model: 'jev', state: STATE, mode: 'demo' });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ ok: true, move: 'down', latencyMs: 402, model: 'jev' });
    expect(result.cache).toBe('no-store');
  });

  it('returns 400 for a body that is not JSON', async () => {
    const result = await call('not json at all');
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ ok: false, error: 'bad_request' });
  });

  it.each([
    ['a missing model', { state: STATE, mode: 'demo' }],
    ['an unknown model', { model: 'llama', state: STATE, mode: 'demo' }],
    ['an unknown mode', { model: 'jev', state: STATE, mode: 'tournament' }],
    ['a missing state', { model: 'jev', mode: 'demo' }],
    ['a state field of the wrong type', { model: 'jev', state: { ...STATE, paddle: { y: 'low', h: 20 } }, mode: 'demo' }],
    ['a non-finite number', { model: 'jev', state: { ...STATE, interceptY: 'Infinity' }, mode: 'demo' }],
    ['an unknown direction', { model: 'jev', state: { ...STATE, dir: 'sideways' }, mode: 'demo' }],
  ])('returns 400 for %s', async (_label, body) => {
    const result = await call(body);
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ ok: false, error: 'bad_request' });
    expect(jev).not.toHaveBeenCalled();
    expect(llm).not.toHaveBeenCalled();
  });

  it('accepts a null intercept', async () => {
    jev.mockResolvedValue({ move: 'stay', latencyMs: 300 });
    const result = await call({ model: 'jev', state: { ...STATE, interceptY: null, dir: 'away' }, mode: 'demo' });
    expect(result.status).toBe(200);
  });

  it('returns 403 when a watch-only lane is asked to play', async () => {
    const result = await call({ model: 'haiku', state: STATE, mode: 'play' });
    expect(result.status).toBe(403);
    expect(result.body).toMatchObject({ ok: false, error: 'model_not_allowed' });
  });

  it('returns 400 for a locally decided model', async () => {
    const result = await call({ model: 'wall', state: STATE, mode: 'demo' });
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ ok: false, error: 'bad_request' });
  });

  it('returns 402 when the Gateway budget is gone', async () => {
    jev.mockRejectedValue(new Error('quota_for_entity_exceeded'));
    const result = await call({ model: 'jev', state: STATE, mode: 'demo' });
    expect(result.status).toBe(402);
    expect(result.body).toMatchObject({ ok: false, error: 'out_of_credits' });
  });

  it('returns 429 when the Gateway rate limits', async () => {
    llm.mockRejectedValue(Object.assign(new Error('slow down'), { statusCode: 429 }));
    const result = await call({ model: 'gemini', state: STATE, mode: 'demo' });
    expect(result.status).toBe(429);
    expect(result.body).toMatchObject({ ok: false, error: 'rate_limited' });
  });

  it('returns 502 when the model call fails for any other reason', async () => {
    jev.mockRejectedValue(new Error('socket hang up'));
    const result = await call({ model: 'jev', state: STATE, mode: 'demo' });
    expect(result.status).toBe(502);
    expect(result.body).toEqual({ ok: false, error: 'model_error', message: 'socket hang up' });
  });

  it('marks every response no-store', async () => {
    const result = await call({ model: 'wall', state: STATE, mode: 'demo' });
    expect(result.cache).toBe('no-store');
  });
});

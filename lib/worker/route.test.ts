/**
 * Covers app/api/game/route.ts. Lives here because lib/worker owns the route.
 *
 * Both sides of the route are faked: the worker (so nothing connects) and
 * `Ably.Rest` (so the live-game count is whatever the test says it is).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHANNELS } from '../game/types';

const presenceGet = vi.fn();

vi.mock('ably', () => ({
  Rest: class {
    readonly channels = {
      get: (name: string) => ({ name, presence: { get: presenceGet } }),
    };
  },
}));

vi.mock('next/server', () => ({ after: vi.fn() }));

vi.mock('./game-worker', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./game-worker')>()),
  runGameWorker: vi.fn(),
}));

const { POST, DEFAULT_MAX_LIVE_GAMES, maxDuration } = await import('../../app/api/game/route');
const { after } = await import('next/server');
const { runGameWorker } = await import('./game-worker');
const runWorker = vi.mocked(runGameWorker);
const afterMock = vi.mocked(after);

const KEY = 'app.key:secret';

function post(body: unknown): Request {
  return new Request('http://localhost/api/game', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function call(body: unknown): Promise<{ status: number; body: Record<string, unknown>; cache: string | null }> {
  const response = await POST(post(body));
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
    cache: response.headers.get('cache-control'),
  };
}

/** Run whatever the route handed to `after()`, as the platform would. */
function runAfter(): unknown {
  const callback = afterMock.mock.calls[0][0];
  return typeof callback === 'function' ? callback() : undefined;
}

beforeEach(() => {
  process.env.ABLY_API_KEY = KEY;
  delete process.env.MAX_LIVE_GAMES;
  presenceGet.mockResolvedValue({ items: [] });
  runWorker.mockResolvedValue({ reason: 'won', score: [5, 3], ticks: 120, durationMs: 42_000 });
});

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.ABLY_API_KEY;
  delete process.env.MAX_LIVE_GAMES;
});

describe('POST /api/game', () => {
  it('is configured to outlive the response', () => {
    expect(maxDuration).toBe(800);
  });

  it('returns 503 when there is no Ably key', async () => {
    delete process.env.ABLY_API_KEY;
    const result = await call({ mode: 'demo' });

    expect(result.status).toBe(503);
    expect(result.body).toEqual({ error: 'ably_not_configured' });
    expect(afterMock).not.toHaveBeenCalled();
  });

  it.each([
    ['a body that is not JSON', 'not json at all'],
    ['a missing mode', {}],
    ['an unknown mode', { mode: 'tournament' }],
    ['an unknown model', { mode: 'demo', model: 'llama' }],
    ['a local model', { mode: 'demo', model: 'mock' }],
  ])('returns 400 for %s', async (_label, body) => {
    const result = await call(body);

    expect(result.status).toBe(400);
    expect(result.body.error).toBe('bad_request');
    expect(afterMock).not.toHaveBeenCalled();
    expect(presenceGet).not.toHaveBeenCalled();
  });

  it('refuses a watch-only model in play mode', async () => {
    const result = await call({ mode: 'vs-jev', model: 'gemini' });

    expect(result.status).toBe(403);
    expect(result.body.error).toBe('model_not_allowed');
    expect(afterMock).not.toHaveBeenCalled();
  });

  it('starts the game and answers with the channel to join', async () => {
    const result = await call({ mode: 'vs-jev' });

    expect(result.status).toBe(201);
    expect(result.cache).toBe('no-store');
    expect(result.body.mode).toBe('vs-jev');
    expect(result.body.model).toBe('jev');

    const gameId = result.body.gameId as string;
    expect(gameId).toMatch(/^[a-z0-9]{8}$/);
    expect(result.body.channel).toBe(CHANNELS.game(gameId));

    expect(afterMock).toHaveBeenCalledTimes(1);
    expect(runWorker).not.toHaveBeenCalled();

    runAfter();
    expect(runWorker).toHaveBeenCalledTimes(1);
    const passed = runWorker.mock.calls[0][0];
    expect(passed).toMatchObject({ gameId, mode: 'vs-jev', model: 'jev', ablyKey: KEY });
    expect(passed.deadline).toBeInstanceOf(Date);
    // No Vercel context in a test, so the deadline comes from maxDuration.
    expect(passed.deadline!.getTime()).toBeGreaterThan(Date.now());
  });

  it('reports vs-human as a human lane and passes the mode through', async () => {
    const result = await call({ mode: 'vs-human' });

    expect(result.status).toBe(201);
    expect(result.body.model).toBe('human');
    runAfter();
    expect(runWorker.mock.calls[0][0]).toMatchObject({ mode: 'vs-human' });
  });

  it('accepts any demo lane', async () => {
    const result = await call({ mode: 'demo', model: 'haiku' });

    expect(result.status).toBe(201);
    expect(result.body.model).toBe('haiku');
  });

  it('returns 429 once the lobby is full', async () => {
    presenceGet.mockResolvedValue({
      items: Array.from({ length: DEFAULT_MAX_LIVE_GAMES }, (_, i) => ({ clientId: `agent-${i}` })),
    });
    const result = await call({ mode: 'demo' });

    expect(result.status).toBe(429);
    expect(result.body).toEqual({ error: 'too_many_games' });
    expect(afterMock).not.toHaveBeenCalled();
  });

  it('honours MAX_LIVE_GAMES', async () => {
    process.env.MAX_LIVE_GAMES = '2';
    presenceGet.mockResolvedValue({ items: [{ clientId: 'a' }, { clientId: 'b' }] });

    expect((await call({ mode: 'demo' })).status).toBe(429);
  });

  it('returns 502 when the lobby cannot be read', async () => {
    presenceGet.mockRejectedValue(new Error('unauthorised'));
    const result = await call({ mode: 'demo' });

    expect(result.status).toBe(502);
    expect(result.body.error).toBe('lobby_unavailable');
    expect(afterMock).not.toHaveBeenCalled();
  });
  it('hands after() a promise that settles only when the worker settles', async () => {
    // Vercel keeps the invocation alive for exactly as long as this promise is
    // pending. A callback returning undefined would let the platform freeze the
    // function before the first decision.
    type Summary = Awaited<ReturnType<typeof runGameWorker>>;
    let finishWorker!: (summary: Summary) => void;
    runWorker.mockReturnValueOnce(
      new Promise<Summary>((resolve) => {
        finishWorker = resolve;
      }),
    );

    const result = await call({ mode: 'vs-jev' });
    expect(result.status).toBe(201);

    const pending = runAfter();
    expect(pending).toBeInstanceOf(Promise);

    let settled = false;
    void (pending as Promise<unknown>).then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe(false);

    finishWorker({ reason: 'won', score: [5, 0], ticks: 10, durationMs: 1000 });
    await pending;
    expect(settled).toBe(true);
  });

  it('keeps the promise alive through a worker failure and never rejects it', async () => {
    runWorker.mockRejectedValueOnce(new Error('boom app.key:secret'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await call({ mode: 'vs-jev' });
    const pending = runAfter();
    await expect(pending).resolves.toBeUndefined();

    const logged = errorSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logged).toContain('worker failed');
    expect(logged).not.toContain('app.key:secret');
    errorSpy.mockRestore();
  });

  describe('demo mode gating', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('refuses a demo game in production without the admin token', async () => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('ADMIN_TOKEN', 'arena-secret');

      const result = await call({ mode: 'demo', model: 'gemini' });

      expect(result.status).toBe(403);
      expect(result.body.error).toBe('admin_required');
      expect(afterMock).not.toHaveBeenCalled();
    });

    it('starts a demo game in production when the admin token header matches', async () => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('ADMIN_TOKEN', 'arena-secret');

      const response = await POST(
        new Request('http://localhost/api/game', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-admin-token': 'arena-secret' },
          body: JSON.stringify({ mode: 'demo', model: 'gemini' }),
        }),
      );

      expect(response.status).toBe(201);
      expect(afterMock).toHaveBeenCalledTimes(1);
    });

    it('lets demo games through outside production', async () => {
      vi.stubEnv('NODE_ENV', 'development');

      const result = await call({ mode: 'demo', model: 'haiku' });

      expect(result.status).toBe(201);
    });
  });
});

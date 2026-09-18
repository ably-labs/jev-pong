import { afterEach, describe, expect, it, vi } from 'vitest';
import { GAME_ENDPOINT, startGame } from './start-game';

interface Call {
  url: string;
  init: RequestInit;
}

/** Record what was sent and reply with the given status and body. */
function stubFetch(status: number, body: unknown, calls: Call[] = []): Call[] {
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(
      new Response(body === undefined ? null : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('startGame — what goes on the wire', () => {
  it('POSTs the mode and model as JSON to /api/game', async () => {
    const calls = stubFetch(201, { gameId: 'bcdfghjk', channel: 'pong:game:bcdfghjk' });
    await startGame({ mode: 'vs-jev', model: 'jev' });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(GAME_ENDPOINT);
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.body).toBe('{"mode":"vs-jev","model":"jev"}');
    expect(calls[0].init.cache).toBe('no-store');
    expect(new Headers(calls[0].init.headers).get('content-type')).toBe('application/json');
  });

  it('sends demo mode with the model for each arena lane', async () => {
    const calls = stubFetch(201, { gameId: 'bcdfghjk' });
    await startGame({ mode: 'demo', model: 'haiku' });
    expect(calls[0].init.body).toBe('{"mode":"demo","model":"haiku"}');
  });

  it('carries no admin header when the browser has no token', async () => {
    const calls = stubFetch(201, { gameId: 'bcdfghjk' });
    await startGame({ mode: 'vs-jev' });
    expect(new Headers(calls[0].init.headers).get('x-admin-token')).toBeNull();
  });
});

describe('startGame — what comes back', () => {
  it('returns the game id on 201', async () => {
    stubFetch(201, { gameId: 'bcdfghjk', channel: 'pong:game:bcdfghjk', mode: 'vs-jev' });
    await expect(startGame({ mode: 'vs-jev' })).resolves.toEqual({ ok: true, gameId: 'bcdfghjk' });
  });

  it('maps 503 ably_not_configured', async () => {
    stubFetch(503, { error: 'ably_not_configured' });
    await expect(startGame({ mode: 'vs-jev' })).resolves.toEqual({
      ok: false,
      error: 'ably_not_configured',
    });
  });

  it('maps 429 too_many_games', async () => {
    stubFetch(429, { error: 'too_many_games' });
    await expect(startGame({ mode: 'demo', model: 'gpt' })).resolves.toEqual({
      ok: false,
      error: 'too_many_games',
    });
  });

  it('maps 403 model_not_allowed', async () => {
    stubFetch(403, { error: 'model_not_allowed', message: 'watch-only' });
    await expect(startGame({ mode: 'vs-jev', model: 'gpt' })).resolves.toEqual({
      ok: false,
      error: 'model_not_allowed',
    });
  });

  it('treats a 201 with no usable id as a failure', async () => {
    stubFetch(201, { channel: 'pong:game:bcdfghjk' });
    await expect(startGame({ mode: 'vs-jev' })).resolves.toEqual({
      ok: false,
      error: 'unavailable',
    });
  });

  it('treats an unreadable body as a failure rather than throwing', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('<html>502</html>', { status: 201 })));
    await expect(startGame({ mode: 'vs-jev' })).resolves.toEqual({
      ok: false,
      error: 'unavailable',
    });
  });

  it('turns a dead network into a failure rather than throwing', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')));
    await expect(startGame({ mode: 'vs-jev' })).resolves.toEqual({
      ok: false,
      error: 'unavailable',
    });
  });
});

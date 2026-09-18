/** Covers app/api/record/route.ts. Lives here because lib/record owns it. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./record-lanes', () => ({ recordLanes: vi.fn() }));

const { POST, maxDuration } = await import('../../app/api/record/route');
const { recordLanes } = await import('./record-lanes');
const record = vi.mocked(recordLanes);

const REPLAY = { version: 1, recordedAt: 'now', seed: 1, lanes: [] };
const STATS = { version: 1, recordedAt: 'now', seed: 1, seconds: 45, lanes: [] };

function post(body?: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/record', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(() => {
  record.mockResolvedValue({
    replay: REPLAY,
    stats: STATS,
  } as unknown as Awaited<ReturnType<typeof recordLanes>>);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe('POST /api/record', () => {
  it('runs the recording in the request and never caches the result', async () => {
    const response = await POST(post({ seconds: 12, seed: 7 }));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(record).toHaveBeenCalledWith({ seconds: 12, seed: 7, lanes: undefined });

    const body = (await response.json()) as { replay: unknown; stats: unknown };
    expect(body.replay).toEqual(REPLAY);
    expect(body.stats).toEqual(STATS);
  });

  it('defaults to a 45 second run when the body is empty', async () => {
    const response = await POST(post());
    expect(response.status).toBe(200);
    expect(record).toHaveBeenCalledWith({
      seconds: 45,
      seed: 20260917,
      lanes: undefined,
    });
  });

  it('is forbidden in production without the admin token', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('ADMIN_TOKEN', 'sesame');

    const response = await POST(post({ seconds: 12 }));
    expect(response.status).toBe(403);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(record).not.toHaveBeenCalled();
  });

  it('is allowed in production with the admin token', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('ADMIN_TOKEN', 'sesame');

    const response = await POST(post({ seconds: 12 }, { 'x-admin-token': 'sesame' }));
    expect(response.status).toBe(200);
    expect(record).toHaveBeenCalledOnce();
  });

  it('rejects a recording longer than the in-request ceiling', async () => {
    const response = await POST(post({ seconds: 601 }));
    expect(response.status).toBe(400);
    expect(record).not.toHaveBeenCalled();

    const body = (await response.json()) as { error: string };
    expect(body.error).toBe('bad_request');
  });

  it('rejects a body that is not JSON, and an unknown lane', async () => {
    const bad = new Request('http://localhost/api/record', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{oops',
    });
    expect((await POST(bad)).status).toBe(400);
    expect((await POST(post({ lanes: ['nope'] }))).status).toBe(400);
    expect(record).not.toHaveBeenCalled();
  });

  it('reports a failed recording as a 500 rather than throwing', async () => {
    record.mockRejectedValueOnce(new Error('gateway is out of credits'));
    const response = await POST(post({ seconds: 5 }));
    expect(response.status).toBe(500);
    expect((await response.json()) as { message: string }).toMatchObject({
      error: 'record_failed',
      message: 'gateway is out of credits',
    });
  });

  it('declares the Vercel Pro duration ceiling', () => {
    expect(maxDuration).toBe(800);
  });
});

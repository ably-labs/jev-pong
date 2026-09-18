/**
 * Tests for `app/api/ably-token/route.ts`.
 *
 * It lives here rather than beside the route so it is covered by the same
 * `lib/ably/*.test.ts` ownership as the rest of the Ably layer.
 *
 * No network: `Ably.Rest.auth.createTokenRequest()` signs the request locally
 * with the key, so a syntactically valid throwaway key is all that is needed.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GET, TOKEN_TTL_MS } from '../../app/api/ably-token/route';
import { CLIENT_ID_MAX_LENGTH, CLIENT_ID_PATTERN } from './ids';

/** Well-formed shape (`appId.keyId:secret`), entirely made up. */
const FAKE_KEY = 'jevpong.test:this-is-not-a-real-secret';

let savedKey: string | undefined;

function get(query = ''): Promise<Response> {
  return GET(new Request(`http://localhost:3000/api/ably-token${query}`));
}

interface TokenRequestBody {
  keyName: string;
  clientId?: string;
  capability: string;
  mac: string;
  nonce: string;
  timestamp: number;
  ttl?: number;
}

beforeEach(() => {
  savedKey = process.env.ABLY_API_KEY;
});

afterEach(() => {
  if (savedKey === undefined) delete process.env.ABLY_API_KEY;
  else process.env.ABLY_API_KEY = savedKey;
});

describe('GET /api/ably-token — no key configured', () => {
  it('returns 503 ably_not_configured when ABLY_API_KEY is unset', async () => {
    delete process.env.ABLY_API_KEY;

    const response = await get();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: 'ably_not_configured' });
  });

  it('treats an empty ABLY_API_KEY as unset', async () => {
    process.env.ABLY_API_KEY = '';

    const response = await get();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: 'ably_not_configured' });
  });

  it('is never cached', async () => {
    delete process.env.ABLY_API_KEY;

    const response = await get();

    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});

describe('GET /api/ably-token — clientId validation', () => {
  beforeEach(() => {
    process.env.ABLY_API_KEY = FAKE_KEY;
  });

  it.each([
    ['a space', 'has space'],
    ['a wildcard', 'bad*'],
    ['a colon', 'app.key:secret'],
    ['a slash', 'a/b'],
    ['empty', ''],
    ['over the length cap', 'a'.repeat(CLIENT_ID_MAX_LENGTH + 1)],
  ])('rejects %s with 400', async (_label, clientId) => {
    const response = await get(`?clientId=${encodeURIComponent(clientId)}`);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'invalid_client_id' });
  });

  it('uses a supplied clientId verbatim', async () => {
    const response = await get('?clientId=spectator-42');

    expect(response.status).toBe(200);
    const body = (await response.json()) as TokenRequestBody;
    expect(body.clientId).toBe('spectator-42');
  });

  it('generates a valid clientId when none is supplied', async () => {
    const response = await get();

    expect(response.status).toBe(200);
    const body = (await response.json()) as TokenRequestBody;
    expect(body.clientId).toBeDefined();
    expect(CLIENT_ID_PATTERN.test(body.clientId as string)).toBe(true);
  });

  it('generates a different clientId each time', async () => {
    const first = (await (await get()).json()) as TokenRequestBody;
    const second = (await (await get()).json()) as TokenRequestBody;

    expect(first.clientId).not.toBe(second.clientId);
  });
});

describe('GET /api/ably-token — token request', () => {
  beforeEach(() => {
    process.env.ABLY_API_KEY = FAKE_KEY;
  });

  it('returns a signed Ably token request scoped to pong channels', async () => {
    const response = await get('?clientId=host-1');

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');

    const body = (await response.json()) as TokenRequestBody;
    expect(body.keyName).toBe('jevpong.test');
    expect(body.mac).toEqual(expect.any(String));
    expect(body.nonce).toEqual(expect.any(String));
    expect(body.timestamp).toEqual(expect.any(Number));
    expect(body.ttl).toBe(TOKEN_TTL_MS);

    const capability = JSON.parse(body.capability) as Record<string, string[]>;
    expect(Object.keys(capability).sort()).toEqual(['pong:game:*', 'pong:lobby']);
    // Browsers read the lobby; only the worker (API key) enters its presence set.
    expect(capability['pong:lobby']).toEqual(['subscribe']);
    expect([...capability['pong:game:*']].sort()).toEqual(['presence', 'publish', 'subscribe']);
  });

  it('never returns the API key or its secret', async () => {
    const response = await get();
    const raw = await response.text();

    expect(raw).not.toContain('this-is-not-a-real-secret');
    expect(raw).not.toContain(FAKE_KEY);
  });
});

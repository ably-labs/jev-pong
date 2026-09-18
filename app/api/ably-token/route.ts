/**
 * GET /api/ably-token — a short-lived Ably token for one browser.
 *
 * WHAT   Returns a signed Ably token request, which the browser SDK exchanges
 *        with Ably for a token. `Ably.Rest` signs it locally from the key, so
 *        this endpoint makes no network call of its own, and there is no
 *        `Ably.Realtime` anywhere on the server.
 * WHO    The browser SDK itself. `lib/ably/client.ts` sets this as `authUrl`,
 *        so every page that opens a connection hits it, and hits it again
 *        whenever a token expires.
 * NEEDS  `ABLY_API_KEY`. This is the only place it is ever read: the key never
 *        leaves the server, and the browser holds nothing that outlives its
 *        token.
 * REFUSES a `clientId` that is not one of ours (400), and answers 503 when the
 *        key is not configured. What a token may then do is CAPABILITY below —
 *        read-only on the lobby.
 */

import * as Ably from 'ably';
import { isValidClientId, newClientId } from '../../../lib/ably/ids';

export const dynamic = 'force-dynamic';

/**
 * What a browser token may do. Browsers only ever READ the lobby: the worker
 * enters lobby presence with the API key, and `POST /api/game` counts those
 * members to cap live games, so a browser must not be able to enter (or it
 * could fill the cap with fakes). `subscribe` covers presence events and
 * `presence.get()`. On game channels a browser needs `presence` (player and
 * spectator membership) and `publish` (its `input` messages). Capabilities
 * cannot be scoped by message name, so a browser could also publish a forged
 * `state`; spectators would see it, the worker ignores it. Acceptable for a demo.
 */
const CAPABILITY: Record<string, Ably.CapabilityOp[]> = {
  'pong:lobby': ['subscribe'],
  'pong:game:*': ['subscribe', 'publish', 'presence'],
};

/** One hour. The SDK renews on expiry through the same `authUrl`. */
export const TOKEN_TTL_MS = 60 * 60 * 1000;

const NO_STORE: HeadersInit = { 'cache-control': 'no-store' };

/**
 * Module-level, keyed on the key itself.
 *
 * `Ably.Rest` is stateless — no socket, no background work — so there is
 * nothing per-request about it, and building one per invocation would re-parse
 * the key and allocate a fresh HTTP agent on every warm-lambda hit for no gain.
 * Keying the cache on the key value (rather than a bare `let`) keeps it honest
 * if the environment changes underneath us, which is what tests do.
 */
let cached: { key: string; rest: Ably.Rest } | null = null;

function restClient(key: string): Ably.Rest {
  if (cached !== null && cached.key === key) return cached.rest;
  const rest = new Ably.Rest({ key });
  cached = { key, rest };
  return rest;
}

export async function GET(request: Request): Promise<Response> {
  const key = process.env.ABLY_API_KEY;
  if (key === undefined || key === '') {
    return Response.json({ error: 'ably_not_configured' }, { status: 503, headers: NO_STORE });
  }

  const requested = new URL(request.url).searchParams.get('clientId');
  if (requested !== null && !isValidClientId(requested)) {
    return Response.json({ error: 'invalid_client_id' }, { status: 400, headers: NO_STORE });
  }
  const clientId = requested ?? newClientId();

  try {
    const tokenRequest = await restClient(key).auth.createTokenRequest({
      clientId,
      capability: CAPABILITY,
      ttl: TOKEN_TTL_MS,
    });
    return Response.json(tokenRequest, { status: 200, headers: NO_STORE });
  } catch (error: unknown) {
    console.error('[ably-token] createTokenRequest failed', error);
    return Response.json({ error: 'token_request_failed' }, { status: 502, headers: NO_STORE });
  }
}

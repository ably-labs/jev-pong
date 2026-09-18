/**
 * Who is allowed to start live games.
 *
 * Everything on this site is free to watch. Starting one costs model credits,
 * so the expensive door — `/arena`, which starts four demo games at once, and
 * `demo` mode on `POST /api/game` — is behind a token.
 *
 * The rule is deliberately blunt:
 *   - not production (a laptop running `next dev`) -> open, because nobody
 *     else can reach it. Vercel previews build with NODE_ENV=production, so
 *     they are gated like production;
 *   - production -> the caller must present `ADMIN_TOKEN`, either as the
 *     `x-admin-token` header or as `?token=` on the URL.
 *
 * With no `ADMIN_TOKEN` set in production the door is simply shut. That is the
 * safe default: a missing secret must never mean "let everyone in".
 *
 * No React, no Next, no Ably import. The server half ({@link isAdminRequest})
 * runs in a route handler or a server component; the browser half
 * ({@link adminHeaders} and friends) runs in a client component. They are in
 * one file because they are two ends of the same rule.
 */

/** Header a browser sends the token in. */
export const ADMIN_TOKEN_HEADER = 'x-admin-token';

/** Query parameter that carries the token instead, for a plain link. */
export const ADMIN_TOKEN_PARAM = 'token';

/** Where the browser remembers a token it has been given. */
export const ADMIN_TOKEN_STORAGE_KEY = 'jevpong.adminToken';

/**
 * Compare two secrets without leaking their length difference through timing.
 *
 * A demo does not have an attacker worth the name, but a token check that
 * short-circuits on the first wrong byte is the kind of thing that gets copied
 * into something that does.
 */
function secretEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** The configured token, or null when there is none to check against. */
function configuredToken(): string | null {
  const token = process.env.ADMIN_TOKEN;
  return token === undefined || token === '' ? null : token;
}

/** `?token=` on a request URL, or null if the URL is unusable. */
function tokenFromUrl(url: string): string | null {
  try {
    return new URL(url).searchParams.get(ADMIN_TOKEN_PARAM);
  } catch {
    // A relative or malformed URL simply carries no token.
    return null;
  }
}

/**
 * True when this request may start live games.
 *
 * Call it from a route handler with the incoming `Request`, or from a server
 * component with a `Request` built out of `headers()` and `searchParams` —
 * `/arena` does exactly that.
 */
export function isAdminRequest(request: Request): boolean {
  if (process.env.NODE_ENV !== 'production') return true;

  const expected = configuredToken();
  if (expected === null) return false;

  const header = request.headers.get(ADMIN_TOKEN_HEADER);
  if (header !== null && secretEquals(header, expected)) return true;

  const query = tokenFromUrl(request.url);
  return query !== null && secretEquals(query, expected);
}

/* ----------------------------------------------------------------- browser */

function storage(): Storage | null {
  // Not a browser, or a browser refusing storage (private mode, blocked
  // cookies). Either way there is no stored token, which is not an error.
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** The token this browser has been given, if any. */
export function readAdminToken(): string | null {
  try {
    const value = storage()?.getItem(ADMIN_TOKEN_STORAGE_KEY) ?? null;
    return value === null || value === '' ? null : value;
  } catch {
    return null;
  }
}

/**
 * Remember a token for later visits.
 *
 * `/arena?token=…` calls this, so the link only has to be used once and the
 * home page can then decide to show the arena link at all.
 */
export function storeAdminToken(token: string): void {
  try {
    if (token === '') storage()?.removeItem(ADMIN_TOKEN_STORAGE_KEY);
    else storage()?.setItem(ADMIN_TOKEN_STORAGE_KEY, token);
  } catch {
    // Nothing to do: the page still works, it just forgets.
  }
}

/** Headers to add to a `fetch` that starts a game. Empty when there is no token. */
export function adminHeaders(): Record<string, string> {
  const token = readAdminToken();
  return token === null ? {} : { [ADMIN_TOKEN_HEADER]: token };
}

/**
 * The browser's own guess at whether it would pass {@link isAdminRequest}.
 *
 * Only a guess: the server decides. It is enough to choose whether to *offer*
 * the arena link, and it must be read after mount, never during render, or the
 * server and client markup disagree.
 */
export function hasAdminAccess(): boolean {
  return process.env.NODE_ENV !== 'production' || readAdminToken() !== null;
}

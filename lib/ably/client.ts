/**
 * The one browser-side Ably connection.
 *
 * Everything in the app shares this instance: the React provider hands it to
 * `ably/react`, and every hook takes its channels from it. One connection is
 * both the cheap and the correct answer — Ably bills connections, and two
 * connections would each need their own token and their own presence member on
 * the lobby.
 *
 * Auth is `authUrl` only. The browser never sees `ABLY_API_KEY`; it GETs a
 * signed token request from `/api/ably-token` and the SDK renews it on expiry.
 */

import * as Ably from 'ably';

/** Where the browser fetches its token request from. */
export const ABLY_AUTH_URL = '/api/ably-token';

let client: Ably.Realtime | null = null;

/**
 * Subscribers to "does the shared client exist yet".
 *
 * The React provider reads this through `useSyncExternalStore` rather than
 * copying the client into `useState` from an effect: the connection genuinely
 * is an external resource with a lifetime of its own, so the effect's job is to
 * create it, not to mirror it into React state.
 */
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of [...listeners]) listener();
}

function isBrowser(): boolean {
  return typeof window !== 'undefined';
}

/**
 * The shared `Ably.Realtime` instance, created on first call.
 *
 * Safe to call repeatedly — React StrictMode's double mount, a re-render, or
 * two components asking at once all get the same object. Throws if called
 * during server rendering: the SDK needs browser APIs, so it must only ever be
 * constructed inside an effect or an event handler.
 */
export function getAblyClient(): Ably.Realtime {
  if (!isBrowser()) {
    throw new Error(
      'getAblyClient() was called outside the browser. The Ably Realtime client needs browser APIs — ' +
        'call it from a client component effect (AblyClientProvider does this) rather than during SSR.',
    );
  }
  if (client !== null && client.connection.state !== 'closed') return client;
  client = new Ably.Realtime({
    authUrl: ABLY_AUTH_URL,
    authMethod: 'GET',
    // A page renders from the worker's snapshots, so its own published input
    // coming back would be nothing but traffic.
    echoMessages: false,
    closeOnUnload: true,
    autoConnect: true,
  });
  notify();
  return client;
}

/**
 * Close the shared connection and forget it. The next `getAblyClient()` builds
 * a fresh one.
 *
 * Note that the provider does *not* call this on unmount, deliberately: under
 * StrictMode that would close the connection between the two mounts, and on a
 * client-side route change it would drop a connection the next page is about to
 * ask for again. `closeOnUnload` covers the page actually going away. Call this
 * only when you mean it — a test, or a "disconnect" control.
 */
export function closeAblyClient(): void {
  const current = client;
  client = null;
  if (current !== null && current.connection.state !== 'closed') current.close();
  notify();
}

/* ------------------------------------------------- useSyncExternalStore API */

/** Watch for the shared client appearing or being closed. */
export function subscribeAblyClient(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The shared client, or `null` if it has not been created yet. */
export function getAblyClientSnapshot(): Ably.Realtime | null {
  return client;
}

/** There is never a client during server rendering. */
export function getAblyClientServerSnapshot(): null {
  return null;
}

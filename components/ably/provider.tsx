'use client';

/**
 * React wiring for the shared Ably connection.
 *
 * Wrap a page (or a subtree) in `<AblyClientProvider>` and every `ably/react`
 * hook below it — and every hook in `lib/ably/hooks.ts` — uses the one
 * connection from `lib/ably/client.ts`.
 *
 * ## When does it connect?
 *
 * On mount, and only on mount. The client is built inside an effect, so it is
 * never constructed during SSR, and `autoConnect` then opens the connection
 * right away.
 *
 * That is deliberate rather than lazy: connecting is exactly what mounting this
 * provider means, so pages that do not need Ably simply do not mount it. `/`
 * plays a recorded replay and stays offline; `/watch/<id>`, `/play` and
 * `/arena` each wrap themselves. Do **not** put this in `app/layout.tsx` — that
 * would open a connection (and burn a token) for every visitor to the landing
 * page.
 */

import { AblyProvider } from 'ably/react';
import { useEffect, useSyncExternalStore, type ReactNode } from 'react';
import {
  getAblyClient,
  getAblyClientServerSnapshot,
  getAblyClientSnapshot,
  subscribeAblyClient,
} from '../../lib/ably/client';

export interface AblyClientProviderProps {
  children: ReactNode;
  /**
   * Shown while the browser-side client is being created — during SSR and on
   * the first paint. Children are not rendered before then, because the hooks
   * inside them need the Ably context to exist. Defaults to nothing.
   */
  fallback?: ReactNode;
}

export function AblyClientProvider({ children, fallback = null }: AblyClientProviderProps) {
  const client = useSyncExternalStore(
    subscribeAblyClient,
    getAblyClientSnapshot,
    getAblyClientServerSnapshot,
  );

  useEffect(() => {
    // Create the connection, do not mirror it into state: it is an external
    // resource read back through the store above.
    //
    // No `close()` in the teardown, on purpose. `getAblyClient()` is a
    // singleton, so StrictMode's mount/unmount/mount gets the same connection
    // back, and a client-side route change does not drop a connection the next
    // page is about to ask for. `closeOnUnload` handles the page going away;
    // `closeAblyClient()` handles the rare deliberate teardown.
    getAblyClient();
  }, []);

  if (client === null) return <>{fallback}</>;
  return <AblyProvider client={client}>{children}</AblyProvider>;
}

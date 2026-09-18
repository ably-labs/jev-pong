'use client';

/**
 * The name this browser has already given, as an external store.
 *
 * `localStorage` is not React state: it exists before the page does, it is not
 * there on the server, and it can be missing entirely (private mode, blocked
 * site data). `useSyncExternalStore` is the honest way to read something like
 * that, and it keeps the three answers apart:
 *
 *   undefined   we cannot know yet — the server render and the hydration pass
 *   null        never asked on this browser
 *   string      asked and answered, '' being a perfectly good answer
 *
 * The middle one matters: if hydration guessed "never asked", a returning
 * player would see the name prompt flash up before their own name arrived.
 */

import { useCallback, useSyncExternalStore } from 'react';
import { loadName, saveName } from '@/lib/ui/name';

type Stored = string | null | undefined;

const listeners = new Set<() => void>();

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

/** Strings and null compare by value, so this is a stable snapshot. */
function readStored(): Stored {
  return loadName();
}

function unknown(): Stored {
  return undefined;
}

export function useStoredName(): [Stored, (value: string) => void] {
  const name = useSyncExternalStore(subscribe, readStored, unknown);

  const answer = useCallback((value: string) => {
    saveName(value);
    for (const listener of listeners) listener();
  }, []);

  return [name, answer];
}

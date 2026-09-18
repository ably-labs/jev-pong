/**
 * The player's name.
 *
 * Asked once, on the play page, before a game is dealt. It is optional: an
 * empty answer is a real answer, and the page falls back to the anon name built
 * from the Ably clientId. Whatever is stored goes out as `name` in the player's
 * presence data, which is where the feed and the watch page read it from.
 *
 * No React, and the only browser API is `localStorage`, guarded — so the pure
 * parts are testable and the module is safe to import on the server.
 */

import { MAX_NAME_LENGTH, sanitiseName } from '../ably/presence';

/** Where the answer lives. Its presence is also "we have asked". */
export const NAME_KEY = 'jevpong.name';

/**
 * Long enough for a real name, short enough not to break a feed line. It is the
 * wire's own limit: a name the channel would cut is not a name to offer.
 */
export const NAME_MAX = MAX_NAME_LENGTH;

/**
 * Tidy a typed name, by exactly the rule the wire applies to it — no control
 * characters, no runs of whitespace, no ragged ends, never longer than
 * {@link NAME_MAX}. An empty result means "no name", which is a valid answer.
 */
export function cleanName(raw: string): string {
  return (sanitiseName(raw) ?? '').trim();
}

/**
 * Read the `name` off a presence payload, whatever else is on it.
 *
 * Deliberately reads the raw wire object rather than a parsed `GamePresence`,
 * so it does not depend on which fields the guard has been taught to copy out.
 */
export function readPresenceName(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null;
  const name = (sanitiseName((data as { name?: unknown }).name) ?? '').trim();
  return name === '' ? null : name;
}

/**
 * The stored answer: a name, `''` for "asked, declined", or null for "never
 * asked". A browser that will not give us storage (private mode, blocked site
 * data) always reads null, so it is asked again — which is harmless.
 */
export function loadName(): string | null {
  const stored = readStored();
  return stored === null ? null : cleanName(stored);
}

/** Remember the answer. Returns what was actually stored. */
export function saveName(raw: string): string {
  const name = cleanName(raw);
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    // A browser that will not store it simply asks again next time.
  }
  return name;
}

function readStored(): string | null {
  try {
    return localStorage.getItem(NAME_KEY);
  } catch {
    return null;
  }
}

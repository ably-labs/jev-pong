/**
 * Id helpers for the Ably layer.
 *
 * No Ably import, no DOM import: this module is safe on the server, in the
 * browser and in a bare Node test runner.
 */

/**
 * Url-safe, unambiguous alphabet. Digits 2-9 and consonants only, so generated
 * ids never read as a word and never contain a 0/O or 1/l/I pair.
 */
const ALPHABET = '23456789bcdfghjkmnpqrstvwxyz';

/** Length of a game id, as used in `/watch/<id>` links. */
export const GAME_ID_LENGTH = 8;

/** Length of the random part of a generated client id. */
const CLIENT_ID_RANDOM_LENGTH = 10;

/** Prefix on generated client ids, so Ably dashboards show where they came from. */
const CLIENT_ID_PREFIX = 'pong-';

/** Longest client id the token route will mint. */
export const CLIENT_ID_MAX_LENGTH = 40;

/**
 * A client id supplied by the caller must match this. Ably itself is far more
 * permissive; we are deliberately not, because the value ends up in channel
 * capability checks, presence keys and log lines.
 *
 * The tail is a lookahead rather than `$`, because in JavaScript `$` also
 * matches immediately before a trailing newline — so `"spectator\n"` would slip
 * through an anchored pattern.
 */
export const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,40}(?![\s\S])/;

function fillRandom(buffer: Uint8Array): void {
  const webCrypto = globalThis.crypto;
  if (webCrypto !== undefined && typeof webCrypto.getRandomValues === 'function') {
    webCrypto.getRandomValues(buffer);
    return;
  }
  // Last resort: ids stay unique enough for a demo even without a CSPRNG.
  for (let i = 0; i < buffer.length; i += 1) {
    buffer[i] = Math.floor(Math.random() * 256);
  }
}

/**
 * Random string over {@link ALPHABET}, using rejection sampling so every
 * character is equally likely whatever the alphabet length.
 */
function randomId(length: number): string {
  const limit = Math.floor(256 / ALPHABET.length) * ALPHABET.length;
  const buffer = new Uint8Array(Math.max(length * 2, 16));
  let out = '';
  while (out.length < length) {
    fillRandom(buffer);
    for (let i = 0; i < buffer.length && out.length < length; i += 1) {
      const byte = buffer[i];
      if (byte < limit) out += ALPHABET[byte % ALPHABET.length];
    }
  }
  return out;
}

/** Short, url-safe id for one game. Shows up in `pong:game:<id>` and in share links. */
export function newGameId(): string {
  return randomId(GAME_ID_LENGTH);
}

/**
 * Client id for a browser that did not bring its own. Always satisfies
 * {@link CLIENT_ID_PATTERN}.
 */
export function newClientId(): string {
  return `${CLIENT_ID_PREFIX}${randomId(CLIENT_ID_RANDOM_LENGTH)}`;
}

/** True when `value` is acceptable as an Ably `clientId` for this app. */
export function isValidClientId(value: string): boolean {
  return CLIENT_ID_PATTERN.test(value);
}

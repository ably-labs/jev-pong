/**
 * Wire shapes and the guards that read them.
 *
 * Everything that arrives from Ably is `unknown`. These are shape checks, not a
 * schema: enough to keep a malformed, stale or hostile payload from reaching
 * the renderer, and cheap enough to run on every message.
 *
 * No React and no Ably import, so this module is usable from the browser, from
 * the Node worker, and from a bare test.
 */

import type { LobbyPresence, Move, Snapshot } from '../game/types';

/* ------------------------------------------------------------ game channel */

/** Who a member of a game channel's presence set is. */
export type GameRole = 'player' | 'agent' | 'spectator';

/**
 * Presence data on `pong:game:<id>`.
 *
 * `agent` is the worker running the lane, `player` is a human driving the left
 * paddle, `spectator` is everyone watching. One participant, three words,
 * depending on where you are standing: present as `spectator` on the channel,
 * counted as `viewers` on the lobby wire, and "N watching" in the copy.
 *
 * `model` is a free string rather than `ModelId`, because the worker is the
 * authority on what it is running and may name something this build does not
 * know about.
 */
export interface GamePresence {
  role: GameRole;
  model?: string;
  side?: 'left' | 'right';
  /**
   * What a player called themselves, so the UI can show a name instead of
   * `anon-1a2b`. Sanitised on the way in (see `sanitiseName`) and IGNORED by the
   * worker: it decides nothing, seats nobody and reaches no model, so a made-up
   * one costs nothing.
   */
  name?: string;
}

/** Longest display name kept. A longer one is cut, not rejected. */
export const MAX_NAME_LENGTH = 24;

/**
 * A display name fit to render: one line, no control characters, no runs of
 * whitespace, at most MAX_NAME_LENGTH characters. Null when nothing is left.
 */
export function sanitiseName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  // Control characters out first (a newline in a name would break a layout),
  // then runs of whitespace, then the length cap.
  const cleaned = Array.from(value)
    .map((char) => ((char.codePointAt(0) ?? 0) < 0x20 || char === '\u007f' ? ' ' : char))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned === '') return null;
  return cleaned.slice(0, MAX_NAME_LENGTH);
}

/** Message name the worker publishes each Snapshot under. */
export const STATE_MESSAGE = 'state';

/** Message name carrying a human's paddle input on a game channel. */
export const INPUT_MESSAGE = 'input';

/**
 * Data of an `input` message. `seq` counts the sender's messages from 1; the
 * worker echoes the newest one it has applied in `Snapshot.inputSeq`.
 */
export interface InputMessage {
  move: Move;
  seq?: number;
}

/* ----------------------------------------------------------------- lobby */

/**
 * What the worker publishes into the lobby presence set.
 *
 * `LobbyPresence` from `lib/game/types.ts` is the fixed contract; `viewers` is
 * added here as an intersection rather than by editing that file, which is
 * shared with three other work streams.
 *
 * There is no guard for it, because nothing reads it back: the lobby set is how
 * `/api/game` counts live games against its cap, and no page lists them.
 */
export type LobbyPresenceWithViewers = LobbyPresence & { viewers: number };

/* ----------------------------------------------------------------- guards */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isRole(value: unknown): value is GameRole {
  return value === 'player' || value === 'agent' || value === 'spectator';
}

function isMove(value: unknown): value is Move {
  return value === 'up' || value === 'down' || value === 'stay';
}

export function asGamePresence(data: unknown): GamePresence | null {
  if (!isRecord(data)) return null;
  if (!isRole(data.role)) return null;
  const presence: GamePresence = { role: data.role };
  if (typeof data.model === 'string') presence.model = data.model;
  if (data.side === 'left' || data.side === 'right') presence.side = data.side;
  const name = sanitiseName(data.name);
  if (name !== null) presence.name = name;
  return presence;
}

export function asInputMessage(data: unknown): InputMessage | null {
  if (!isRecord(data)) return null;
  if (!isMove(data.move)) return null;
  const input: InputMessage = { move: data.move };
  if (typeof data.seq === 'number' && Number.isFinite(data.seq)) input.seq = data.seq;
  return input;
}

export function asSnapshot(data: unknown): Snapshot | null {
  if (!isRecord(data)) return null;
  if (typeof data.t !== 'number' || typeof data.tick !== 'number') return null;
  if (typeof data.status !== 'string' || !isRecord(data.ball)) return null;
  if (!Array.isArray(data.score) || data.score.length !== 2) return null;
  return data as unknown as Snapshot;
}

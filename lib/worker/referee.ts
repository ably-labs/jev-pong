/**
 * Jev Pong — the referee. When does a game stop?
 *
 * A worker is one Vercel invocation holding one Ably connection, so something
 * has to decide when to let go: a won game, an abandoned game, an empty
 * demo, or the function's own deadline. That decision is this file, and it is
 * PURE — no timers, no Ably, no clock of its own. The caller feeds it events
 * and calls `tick(now)`; every verdict is a function of what it has been told.
 *
 * That is what makes it testable: a test passes the times it wants rather than
 * waiting for them.
 *
 * The five ways a game ends, in the order they are checked:
 *   won         a score reached POINTS_TO_WIN.
 *   player_left a required player has been gone longer than the grace window.
 *               The grace exists so a refresh or a flaky tunnel is not a
 *               forfeit — Ably itself takes ~15s to declare an ungraceful
 *               leave, and a reconnecting browser re-enters presence.
 *   no_player   a mode that needs a human never got one.
 *   time_limit  the invocation deadline is close enough that we must shut down
 *               cleanly rather than be killed mid-publish.
 *   idle        nobody is playing and nobody is watching.
 *
 * `idle` has a demo-specific rule. A demo game on the arena page burns model
 * credits with no human involved, so:
 *   - once a spectator has ever been seen, it stops 120s after the last one
 *     leaves (they went away; stop paying for it);
 *   - if nobody ever watched, it runs for 300s before giving up, which is long
 *     enough for someone to open the page and see a game already in flight.
 */

import { POINTS_TO_WIN } from '../game/types';

export type GameMode = 'vs-jev' | 'vs-human' | 'demo';

export type EndReason = 'won' | 'player_left' | 'idle' | 'time_limit' | 'no_player';

export type RefereeVerdict = { end: false } | { end: true; reason: EndReason };

const KEEP_PLAYING: RefereeVerdict = { end: false };

/** How many humans each mode needs before the ball may be served. */
export const REQUIRED_PLAYERS: Record<GameMode, number> = {
  'vs-jev': 1,
  'vs-human': 2,
  demo: 0,
};

/** Grace after a required player disappears, for refreshes and reconnects. */
export const PLAYER_GRACE_MS = 15_000;
/** No input from any player and nobody watching for this long -> 'idle'. */
export const IDLE_MS = 120_000;
/** A demo nobody has ever watched gets this long instead. */
export const EMPTY_DEMO_MS = 300_000;
/** A mode that needs a human waits this long for one. */
export const NO_PLAYER_MS = 60_000;
/** Stop this far before the invocation deadline, leaving room to shut down. */
export const DEADLINE_MARGIN_MS = 15_000;

export interface RefereeOptions {
  mode: GameMode;
  /** The clock value the game started at. All windows are measured from here. */
  startedAt: number;
  /** Invocation deadline, if there is one. */
  deadline?: number | null;
  playerGraceMs?: number;
  idleMs?: number;
  emptyDemoMs?: number;
  noPlayerMs?: number;
  deadlineMarginMs?: number;
}

export interface Referee {
  /** A human took a side. Call with the assigned player's clientId. */
  playerEnter(clientId: string): void;
  /** That human's side is free again. */
  playerLeave(clientId: string): void;
  /** How many spectators are in the presence set right now. */
  spectatorCount(n: number): void;
  /** A player sent an input message. Counts as "someone is still here". */
  input(clientId: string): void;
  /** Latest score, as the engine reports it. */
  score(left: number, right: number): void;
  /** Set or clear the invocation deadline. */
  deadline(at: number | null): void;
  /** The only thing that produces a verdict. Latches once it has ended. */
  tick(now: number): RefereeVerdict;
  /** Diagnostics. */
  readonly state: RefereeState;
}

export interface RefereeState {
  players: readonly string[];
  spectators: number;
  score: readonly [number, number];
  everReady: boolean;
  everSpectator: boolean;
  /** When the required players stopped being present, once they had been. */
  absentSince: number | null;
  /** Last moment a player sent input or a spectator was present. */
  lastActivityAt: number;
  ended: EndReason | null;
}

export function createReferee(options: RefereeOptions): Referee {
  const {
    mode,
    startedAt,
    playerGraceMs = PLAYER_GRACE_MS,
    idleMs = IDLE_MS,
    emptyDemoMs = EMPTY_DEMO_MS,
    noPlayerMs = NO_PLAYER_MS,
    deadlineMarginMs = DEADLINE_MARGIN_MS,
  } = options;

  const required = REQUIRED_PLAYERS[mode];

  const players = new Set<string>();
  let spectators = 0;
  let score: [number, number] = [0, 0];
  let deadlineAt: number | null = options.deadline ?? null;

  // A mode that needs nobody is "ready" from the first instant, which is what
  // switches off both no_player and player_left for demo games.
  let everReady = players.size >= required;
  let everSpectator = false;
  let absentSince: number | null = null;
  let lastActivityAt = startedAt;
  let sawInput = false;
  let ended: EndReason | null = null;

  function verdict(now: number): EndReason | null {
    if (score[0] >= POINTS_TO_WIN || score[1] >= POINTS_TO_WIN) return 'won';

    if (absentSince !== null && now - absentSince > playerGraceMs) return 'player_left';

    if (!everReady && now - startedAt > noPlayerMs) return 'no_player';

    if (deadlineAt !== null && now >= deadlineAt - deadlineMarginMs) return 'time_limit';

    const limit = mode === 'demo' && !everSpectator ? emptyDemoMs : idleMs;
    if (now - lastActivityAt > limit) return 'idle';

    return null;
  }

  return {
    playerEnter(clientId: string): void {
      players.add(clientId);
      if (players.size >= required) everReady = true;
    },

    playerLeave(clientId: string): void {
      players.delete(clientId);
    },

    spectatorCount(n: number): void {
      spectators = Math.max(0, n);
      if (spectators > 0) everSpectator = true;
    },

    input(): void {
      sawInput = true;
    },

    score(left: number, right: number): void {
      score = [left, right];
    },

    deadline(at: number | null): void {
      deadlineAt = at;
    },

    tick(now: number): RefereeVerdict {
      if (ended !== null) return { end: true, reason: ended };

      // Activity is resolved here rather than in the event handlers, so the
      // machine never needs a clock of its own.
      if (spectators > 0 || sawInput) lastActivityAt = now;
      sawInput = false;

      if (players.size >= required) absentSince = null;
      else if (everReady && absentSince === null) absentSince = now;

      const reason = verdict(now);
      if (reason === null) return KEEP_PLAYING;
      ended = reason;
      return { end: true, reason };
    },

    get state(): RefereeState {
      return {
        players: [...players],
        spectators,
        score: [score[0], score[1]],
        everReady,
        everSpectator,
        absentSince,
        lastActivityAt,
        ended,
      };
    },
  };
}

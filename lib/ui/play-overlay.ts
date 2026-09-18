/**
 * What is written across the middle of the court, as a pure function.
 *
 * The play page has three moments where the court alone is not enough:
 *
 *   before the first serve   "Get ready", 3 - 2 - 1, and how to move
 *   just after a point       who got it, for about a second
 *   at the end               who won, and the way back in
 *
 * Every one of them is derived from the snapshot stream plus two elapsed
 * times, so the words are testable without a browser, a channel or a clock.
 * The component owns the clock; this owns the answer.
 */

import { SERVE_DELAY_MS, type LaneStatus } from '../game/types';

/**
 * The pause the countdown counts: the worker's own wait before the first serve,
 * taken from the contract so the two cannot drift apart.
 */
export const SERVE_COUNTDOWN_MS = SERVE_DELAY_MS;

/** The countdown is always three numbers, however long the pause is. */
export const COUNTDOWN_STEPS = 3;

/** How long "Point to you" stays up. Long enough to read, short enough to miss. */
export const POINT_FLASH_MS = 1400;

/**
 * 3, 2, 1 — and 0 once the serve is due. Proportional to the pause, so a
 * different serve delay still counts down exactly three numbers.
 */
export function serveCount(elapsedMs: number, totalMs: number = SERVE_COUNTDOWN_MS): number {
  if (totalMs <= 0) return 0;
  const left = totalMs - Math.max(0, elapsedMs);
  if (left <= 0) return 0;
  return Math.min(COUNTDOWN_STEPS, Math.ceil(left / (totalMs / COUNTDOWN_STEPS)));
}

export type PlayOverlay =
  | { kind: 'none' }
  | { kind: 'countdown'; count: number; title: string; hint: string }
  | { kind: 'point'; title: string }
  | { kind: 'over'; title: string; youWon: boolean };

export interface PlayOverlayInput {
  status: LaneStatus | undefined;
  /** [you, them]. */
  score: readonly [number, number];
  /** Milliseconds the lane has been in `serving`, or null if it is not. */
  servingForMs: number | null;
  /** Milliseconds since the score last changed, or null if it never has. */
  pointAgeMs: number | null;
  /** Who took the last point. */
  pointTo: 'you' | 'them' | null;
  /** Display name of the right paddle, e.g. "Jev". */
  opponent: string;
  /**
   * What to call the left paddle in the point flash: the name the player typed.
   * "Point to Matt" is a scoreboard; "Point to you" is a tooltip. Defaults to
   * "you", which is what a player with no name gets.
   */
  you?: string;
}

/** The result of a finished game, in the words the end card uses. */
export function resultText(
  score: readonly [number, number],
  opponent: string,
): { title: string; youWon: boolean } {
  const youWon = score[0] > score[1];
  const high = Math.max(score[0], score[1]);
  const low = Math.min(score[0], score[1]);
  if (score[0] === score[1]) return { title: `Stopped at ${score[0]}–${score[1]}`, youWon: false };
  return { title: `${youWon ? 'You' : opponent} won ${high}–${low}`, youWon };
}

export function playOverlay(input: PlayOverlayInput): PlayOverlay {
  const { status, score, servingForMs, pointAgeMs, pointTo, opponent, you = 'you' } = input;

  // The end outranks everything: the game really did stop. Why it stopped is
  // the sentence underneath (lib/ui/play-status.ts); this is the scoreline.
  if (status === 'credits') return { kind: 'over', title: 'Out of credits', youWon: false };
  if (status === 'error') return { kind: 'over', title: 'The game stopped', youWon: false };
  if (status === 'over') return { kind: 'over', ...resultText(score, opponent) };

  // The first serve of the game is the one nobody is ready for.
  if (status === 'serving' && servingForMs !== null && score[0] === 0 && score[1] === 0) {
    const count = serveCount(servingForMs);
    if (count > 0) {
      return { kind: 'countdown', count, title: 'Get ready', hint: '↑ ↓ to move' };
    }
  }

  if (pointTo !== null && pointAgeMs !== null && pointAgeMs < POINT_FLASH_MS) {
    return { kind: 'point', title: `Point to ${pointTo === 'you' ? you : opponent}` };
  }

  return { kind: 'none' };
}

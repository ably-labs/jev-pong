/**
 * What `/play` says, as a pure function.
 *
 * The play page has four independent inputs — whether `POST /api/game`
 * succeeded, whether the Ably channel is attached, whether the worker has
 * entered presence, and the latest snapshot — and one answer: the words on the
 * screen and whether the paddle is live. Deriving that in the component would
 * make it untestable without a browser and an Ably connection, so it lives
 * here instead and the component only renders what it is told.
 *
 * No React, no Ably, no Next. Just data in, words out.
 */

import type { SpectateState } from '../ably/hooks';
import type { Snapshot } from '../game/types';

/* --------------------------------------------------- starting a game */

export type DealPhase = 'dealing' | 'ready' | 'failed';

/** Why `POST /api/game` did not give us a game. */
export type DealErrorCode =
  | 'ably_not_configured'
  | 'too_many_games'
  | 'model_not_allowed'
  | 'unavailable';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Turn a failed `POST /api/game` into one of the codes this page knows how to
 * explain. The route's own `error` string wins; the status code is the
 * fallback for a proxy or a platform error that never reached the route.
 */
export function dealErrorFor(status: number, body: unknown): DealErrorCode {
  const code = isRecord(body) && typeof body.error === 'string' ? body.error : '';
  if (code === 'ably_not_configured' || status === 503) return 'ably_not_configured';
  if (code === 'too_many_games' || status === 429) return 'too_many_games';
  if (code === 'model_not_allowed' || status === 403) return 'model_not_allowed';
  return 'unavailable';
}

/** The `gameId` out of a 201 body, or null if the body is not what we expect. */
export function gameIdFrom(body: unknown): string | null {
  if (!isRecord(body)) return null;
  return typeof body.gameId === 'string' && body.gameId !== '' ? body.gameId : null;
}

const DEAL_ERROR_LABEL: Record<DealErrorCode, string> = {
  ably_not_configured: 'not configured',
  too_many_games: 'too many games',
  model_not_allowed: 'not playable',
  unavailable: 'could not start a game',
};

const DEAL_ERROR_DETAIL: Record<DealErrorCode, string> = {
  ably_not_configured:
    'This deployment has no Ably key, so there is no channel to play on. Watching a recorded run still works.',
  too_many_games: 'Every game slot is busy right now. Try again in a minute.',
  model_not_allowed: 'That model is watch-only. Only Jev can be played against.',
  unavailable: 'The server would not start a game. Try again.',
};

/* ------------------------------------------------------- ending a game */

/**
 * The worker sets `message` on its final snapshot to the reason it stopped —
 * the `WorkerEndReason` strings from lib/worker/referee.ts. Anything else is
 * shown as-is, so a reason this build has not heard of still reaches the page.
 */
const END_REASON_TEXT: Record<string, string> = {
  player_left: 'You left the channel, so the game stopped.',
  idle: 'Nobody was playing, so the game stopped.',
  time_limit: 'The game reached its time limit.',
  no_player: 'Nobody took a paddle in time.',
  error: 'The model call failed, so the game stopped.',
};

/** The sentence under "game over". */
export function endReasonText(
  message: string | undefined,
  score: readonly [number, number],
  opponent: string,
): string | null {
  if (message === undefined || message === '') return null;
  if (message === 'won') {
    const winner = score[0] > score[1] ? 'You' : opponent;
    return `${winner} won, ${score[0]}–${score[1]}.`;
  }
  return END_REASON_TEXT[message] ?? message;
}

/* ------------------------------------------------------------ the answer */

export interface PlayStatusInput {
  deal: DealPhase;
  dealError: DealErrorCode | null;
  /** From `useSpectateGame`. */
  connection: SpectateState;
  /** Latest snapshot off the wire, or null before the first one. */
  snapshot: Snapshot | null;
  /** From `useGamePresence`: has the worker entered presence as the agent? */
  agentPresent: boolean;
  /** Display name of whoever holds the right paddle, e.g. "Jev". */
  opponent: string;
}

export interface PlayStatus {
  /**
   * The channel line: "Waiting for Jev to join" until the worker is present,
   * "Jev joined the channel" after. Null when there is no channel to be on.
   */
  presence: string | null;
  /** The game line: serving, playing, point, game over, out of credits. */
  label: string;
  /** A sentence explaining {@link label}, when there is one. */
  detail: string | null;
  tone: 'live' | 'waiting' | 'alarm';
  /** Capture the paddle and publish `input` messages? */
  acceptInput: boolean;
  /** Offer "Play again"? */
  offerRestart: boolean;
}

const STATUS_LABEL: Record<string, string> = {
  idle: 'ready',
  serving: 'serving',
  playing: 'playing',
  point: 'point',
};

export function playStatus(input: PlayStatusInput): PlayStatus {
  const { deal, dealError, connection, snapshot, agentPresent, opponent } = input;

  // 1. We do not have a game yet.
  if (deal === 'dealing') {
    return {
      presence: null,
      label: 'dealing a game',
      detail: null,
      tone: 'waiting',
      acceptInput: false,
      offerRestart: false,
    };
  }

  if (deal === 'failed') {
    const code = dealError ?? 'unavailable';
    return {
      presence: null,
      label: DEAL_ERROR_LABEL[code],
      detail: DEAL_ERROR_DETAIL[code],
      tone: 'alarm',
      acceptInput: false,
      offerRestart: true,
    };
  }

  const presence = agentPresent
    ? `${opponent} joined the channel`
    : `Waiting for ${opponent} to join`;

  // 2. The game itself has something to say. A terminal snapshot outranks the
  //    connection, because the game really did end — the channel going quiet
  //    afterwards is expected, not a fault.
  const status = snapshot?.status;

  if (status === 'credits') {
    return {
      presence,
      label: 'out of credits',
      detail: snapshot?.message ?? 'The model budget for this demo is spent.',
      tone: 'alarm',
      acceptInput: false,
      offerRestart: true,
    };
  }

  if (status === 'error') {
    return {
      presence,
      label: 'error',
      detail: snapshot?.message ?? 'The game stopped with an error.',
      tone: 'alarm',
      acceptInput: false,
      offerRestart: true,
    };
  }

  if (status === 'over') {
    return {
      presence,
      label: 'game over',
      detail: endReasonText(snapshot?.message, snapshot?.score ?? [0, 0], opponent),
      tone: 'waiting',
      acceptInput: false,
      offerRestart: true,
    };
  }

  // 3. No game state to report, so the channel speaks.
  if (connection === 'error') {
    return {
      presence,
      label: 'could not join the game',
      detail: 'The channel is unreachable. Starting a new game usually fixes it.',
      tone: 'alarm',
      acceptInput: false,
      offerRestart: true,
    };
  }

  if (connection === 'connecting' && snapshot === null) {
    return {
      presence,
      label: 'connecting',
      detail: null,
      tone: 'waiting',
      acceptInput: agentPresent,
      offerRestart: false,
    };
  }

  // 4. A live game. Input is accepted even before the worker's first snapshot:
  //    it is level-triggered, so an early move is simply the paddle's position
  //    when play starts.
  return {
    presence,
    label: status === undefined ? 'waiting for the first move' : (STATUS_LABEL[status] ?? status),
    detail: null,
    tone: agentPresent ? 'live' : 'waiting',
    acceptInput: true,
    offerRestart: false,
  };
}

/* ------------------------------------------------------- watching a game */

export type WatchTone = 'connecting' | 'live' | 'ended';

export interface WatchStatus {
  tone: WatchTone;
  /** The words beside the dot in the header. */
  label: string;
}

/**
 * What `/watch/<id>` says in its header: connecting, live, or ended with the
 * reason the worker gave. Pure, so the three states are testable without a
 * browser or a channel.
 */
export function watchStatus(
  connection: SpectateState,
  snapshot: Snapshot | null,
  opponent: string,
  player: string,
): WatchStatus {
  const status = snapshot?.status;

  if (status === 'credits') return { tone: 'ended', label: 'Ended · out of credits' };
  if (status === 'error') return { tone: 'ended', label: 'Ended · the game stopped' };
  if (status === 'over') {
    const score = snapshot?.score ?? [0, 0];
    if (snapshot?.message === 'won') {
      const winner = score[0] > score[1] ? player : opponent;
      const high = Math.max(score[0], score[1]);
      const low = Math.min(score[0], score[1]);
      return { tone: 'ended', label: `Ended · ${winner} won ${high}–${low}` };
    }
    if (snapshot?.message === 'player_left') {
      return { tone: 'ended', label: `Ended · ${player} left` };
    }
    return { tone: 'ended', label: 'Ended · game over' };
  }

  if (connection === 'ended') return { tone: 'ended', label: 'Ended · game over' };
  if (connection === 'error') return { tone: 'ended', label: 'Ended · channel unreachable' };
  if (connection === 'connecting' && snapshot === null) {
    return { tone: 'connecting', label: 'Connecting…' };
  }
  return { tone: 'live', label: 'Live' };
}

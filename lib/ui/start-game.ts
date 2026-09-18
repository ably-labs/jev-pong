/**
 * The browser side of `POST /api/game`.
 *
 * One request starts one server-side worker, which joins `pong:game:<id>` and
 * runs the whole game there. All the browser gets back is the id — everything
 * after that happens over Ably.
 *
 * Kept apart from the pages so the wire format is written down once and can be
 * tested without React.
 */

import { adminHeaders } from '../config/admin';
import type { ModelId } from '../game/types';
import { dealErrorFor, gameIdFrom, type DealErrorCode } from './play-status';

/**
 * Modes the route accepts. Mirrors `GameMode` in lib/worker/referee.ts:
 *   vs-jev    a human on the left, the model on the right
 *   vs-human  two humans, no model
 *   demo      the scripted wall on the left, the model on the right
 */
export type GameMode = 'vs-jev' | 'vs-human' | 'demo';

export interface StartGameRequest {
  mode: GameMode;
  /** Which model takes the right paddle. The route defaults it to 'jev'. */
  model?: ModelId;
}

export type StartGameResult =
  | { ok: true; gameId: string }
  | { ok: false; error: DealErrorCode };

/** Where games are started. */
export const GAME_ENDPOINT = '/api/game';

/**
 * Ask for a game.
 *
 * Never throws and never rejects: every failure — a 503 with no Ably key, a 429
 * with every slot busy, a dead network — comes back as a `DealErrorCode` the
 * page knows how to put into words.
 *
 * `demo` mode is gated in production, so the admin token goes on every request;
 * {@link adminHeaders} is empty when there is none, which is the normal case.
 */
export async function startGame(request: StartGameRequest): Promise<StartGameResult> {
  let response: Response;
  try {
    response = await fetch(GAME_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...adminHeaders() },
      body: JSON.stringify(request),
      cache: 'no-store',
    });
  } catch {
    return { ok: false, error: 'unavailable' };
  }

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // A body-less error is still an error; a body-less success is not a success.
    body = null;
  }

  if (!response.ok) return { ok: false, error: dealErrorFor(response.status, body) };

  const gameId = gameIdFrom(body);
  return gameId === null ? { ok: false, error: 'unavailable' } : { ok: true, gameId };
}

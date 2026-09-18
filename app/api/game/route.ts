/**
 * POST /api/game — start one game and keep running it.
 *
 * WHAT   The response comes back at once with the game id and the channel to
 *        join; the game itself runs in `after()`, which keeps this invocation
 *        alive after the response has been sent, for up to `maxDuration`. One
 *        HTTP request = one function = one Ably connection = one game, and
 *        there is no game loop anywhere else.
 * WHO    `/play` asks for `{ mode: 'vs-jev' }`; `/arena` asks for four
 *        `{ mode: 'demo', model }` games, one per lane.
 * NEEDS  `ABLY_API_KEY` for the worker's connection, and Gateway auth for its
 *        model calls (`AI_GATEWAY_API_KEY`, or Vercel OIDC on a linked
 *        project). `MAX_LIVE_GAMES` caps how many may run at once.
 * REFUSES a body that is not `{ mode, model? }`; a watch-only model in
 *        `vs-jev`, which the decider would turn down on every call; a `demo`
 *        game without the admin token, because it spends model credit with
 *        nobody playing; and anything at all once the lobby is full.
 *
 * The worker has to stop cleanly BEFORE the platform kills the invocation, or
 * a game would end with a dead channel and a stuck lobby entry. That is what
 * `getDeadline()` is for: on Vercel it is the real invocation deadline, and off
 * Vercel (local `next dev`) it is undefined, so we derive one from
 * `maxDuration`.
 */

import { getDeadline } from '@vercel/functions';
import * as Ably from 'ably';
import { after } from 'next/server';
import { z } from 'zod';
import { newGameId } from '../../../lib/ably/ids';
import { isAdminRequest } from '../../../lib/config/admin';
import { GATEWAY_MODELS } from '../../../lib/decide';
import { CHANNELS, PLAYABLE, type ModelId } from '../../../lib/game/types';
import { runGameWorker, safeText } from '../../../lib/worker/game-worker';
import type { GameMode } from '../../../lib/worker/referee';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** Vercel Pro ceiling. The worker stops 15s before the deadline this implies. */
export const maxDuration = 800;

/** Games that may run at once, counted from the lobby presence set. */
export const DEFAULT_MAX_LIVE_GAMES = 20;

const MODES = ['vs-jev', 'vs-human', 'demo'] as const satisfies readonly GameMode[];

const bodySchema = z.object({
  mode: z.enum(MODES),
  model: z.enum(GATEWAY_MODELS).optional(),
});

const NO_STORE: HeadersInit = { 'Cache-Control': 'no-store' };

function fail(status: number, error: string, message?: string): Response {
  return Response.json(
    message === undefined ? { error } : { error, message },
    { status, headers: NO_STORE },
  );
}

function maxLiveGames(): number {
  const parsed = Number.parseInt(process.env.MAX_LIVE_GAMES ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_LIVE_GAMES;
}

/** How many games are live right now. One lobby presence member per game. */
async function liveGames(key: string): Promise<number> {
  const rest = new Ably.Rest({ key });
  const page = await rest.channels.get(CHANNELS.lobby).presence.get();
  return page.items.length;
}

export async function POST(request: Request): Promise<Response> {
  const key = process.env.ABLY_API_KEY;
  if (key === undefined || key === '') {
    return fail(503, 'ably_not_configured');
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return fail(400, 'bad_request', 'Body must be JSON.');
  }

  const parsed = bodySchema.safeParse(payload);
  if (!parsed.success) {
    const where = parsed.error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
      .join('; ');
    return fail(400, 'bad_request', `Invalid request. ${where}`);
  }

  const { mode } = parsed.data;
  const model: ModelId = parsed.data.model ?? 'jev';

  // Watch-only lanes can be demoed but not played against: the decider would
  // refuse every call, so the game would end before it started.
  if (mode === 'vs-jev' && !PLAYABLE.includes(model)) {
    return fail(403, 'model_not_allowed', `"${model}" is watch-only. Playable: ${PLAYABLE.join(', ')}.`);
  }

  // Demo games (wall vs model) burn Gateway credit with nobody playing, so in
  // production only the arena, with the admin token, may start them.
  if (mode === 'demo' && !isAdminRequest(request)) {
    return fail(403, 'admin_required', 'Demo games need the admin token in production.');
  }

  let live: number;
  try {
    live = await liveGames(key);
  } catch {
    return fail(502, 'lobby_unavailable', 'Could not read the lobby presence set.');
  }
  if (live >= maxLiveGames()) {
    return fail(429, 'too_many_games');
  }

  const gameId = newGameId();
  const deadline = getDeadline() ?? new Date(Date.now() + maxDuration * 1000);
  const laneModel: ModelId = mode === 'vs-human' ? 'human' : model;

  // The callback's promise is what keeps this invocation alive: `after()` hands
  // it to the platform's waitUntil, and the function may be frozen the moment
  // it settles. So the whole game must be inside it — never a fire-and-forget.
  after(() =>
    runGameWorker({
      gameId,
      mode,
      model,
      deadline,
      ablyKey: key,
      log: (message) => console.log(`[game ${gameId}] ${message}`),
    })
      .then((summary) => {
        console.log(
          `[game ${gameId}] ${summary.reason} ${summary.score.join('-')} ` +
            `after ${summary.ticks} ticks in ${summary.durationMs}ms`,
        );
      })
      .catch((error: unknown) => {
        const text = error instanceof Error ? error.message : String(error);
        console.error(`[game ${gameId}] worker failed: ${safeText(text, key)}`);
      }),
  );

  return Response.json(
    { gameId, channel: CHANNELS.game(gameId), model: laneModel, mode },
    { status: 201, headers: NO_STORE },
  );
}

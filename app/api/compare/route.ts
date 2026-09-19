/**
 * POST /api/compare — put the Pong question to one model, from Vercel.
 *
 * WHAT   Runs one comparison lane (see lib/compare) over the standard game
 *        states and returns its row. It runs HERE for the same reason
 *        /api/record does: the number has to be function-to-Gateway, not a
 *        laptop's broadband. One lane per request keeps the slowest model
 *        (about four seconds a call, thirty-two calls) well inside the clock.
 * WHO    `scripts/compare-models.ts`, lane by lane, when
 *        `public/model-comparison.json` needs re-measuring.
 * NEEDS  Gateway auth and `ADMIN_TOKEN`, as /api/record does.
 * REFUSES a request without the admin token, an unknown lane, or more than
 *        MAX_STATES states.
 */
import { z } from 'zod';
import { COMPARE_LANE_KEYS, DEFAULT_STATES, MAX_STATES, compareLane, compareStates, runLane } from '../../../lib/compare/compare-models';
import { isAdminRequest } from '../../../lib/config/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** Vercel Pro ceiling. */
export const maxDuration = 800;

const bodySchema = z.object({
  lane: z.enum(COMPARE_LANE_KEYS as [string, ...string[]]),
  states: z.number().int().positive().max(MAX_STATES).optional(),
});

const NO_STORE = { 'cache-control': 'no-store' } as const;

function json(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

export async function POST(request: Request): Promise<Response> {
  if (!isAdminRequest(request)) {
    return json({ error: 'forbidden', message: 'This endpoint needs an admin token.' }, 403);
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return json({ error: 'bad_request', message: 'Body must be JSON.' }, 400);
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return json({ error: 'bad_request', message: parsed.error.issues.map((i) => i.message).join('; ') }, 400);
  }

  const lane = compareLane(parsed.data.lane);
  if (lane === undefined) return json({ error: 'bad_request', message: 'Unknown lane.' }, 400);

  const startedAt = new Date().toISOString();
  const row = await runLane(lane, { states: compareStates(parsed.data.states ?? DEFAULT_STATES) });
  return json({ row, startedAt, region: process.env.VERCEL_REGION ?? null }, 200);
}

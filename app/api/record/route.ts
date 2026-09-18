/**
 * POST /api/record — record a real run of every demo lane, from Vercel.
 *
 * WHAT   Runs every lane against the live Gateway for a few seconds and returns
 *        the replay and its stats. This is where the replay we ship comes from,
 *        and it matters that it runs HERE rather than on a laptop: the
 *        latencies on screen must be worker-to-Gateway, not somebody's home
 *        broadband. The run happens inside the request — no `after()` — because
 *        the caller wants the tape back.
 * WHO    A person, by hand, when `public/replay.json` needs re-recording.
 *        `scripts/record-replay.ts` runs the same code from a laptop.
 * NEEDS  Gateway auth (`AI_GATEWAY_API_KEY`, or Vercel OIDC on a linked
 *        project) and `ADMIN_TOKEN`.
 * REFUSES a request without the admin token, and a recording longer than
 *        MAX_SECONDS. Two ceilings bound it: `maxDuration` is 800 s (Vercel
 *        Pro) and a response body must stay under 4.5 MB — at ~80 KB per lane
 *        for 45 s, the clock binds long before the payload does.
 */
import { z } from 'zod';
import { isAdminRequest } from '../../../lib/config/admin';
import { GATEWAY_MODELS } from '../../../lib/decide';
import { recordLanes } from '../../../lib/record/record-lanes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** Vercel Pro ceiling. A recording longer than this cannot finish in-request. */
export const maxDuration = 800;

/** Leaves headroom under maxDuration for cold start and serialisation. */
const MAX_SECONDS = 600;
const DEFAULT_SECONDS = 45;
const DEFAULT_SEED = 20260917;

const bodySchema = z.object({
  seconds: z.number().positive().max(MAX_SECONDS).optional(),
  seed: z.number().int().optional(),
  lanes: z.array(z.enum(GATEWAY_MODELS)).nonempty().optional(),
});

const NO_STORE = { 'cache-control': 'no-store' } as const;

function json(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

export async function POST(request: Request): Promise<Response> {
  if (!isAdminRequest(request)) {
    return json({ error: 'forbidden', message: 'This endpoint needs an admin token.' }, 403);
  }

  let raw: unknown = {};
  const text = await request.text();
  if (text.trim() !== '') {
    try {
      raw = JSON.parse(text);
    } catch {
      return json({ error: 'bad_request', message: 'Body must be JSON.' }, 400);
    }
  }

  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return json(
      {
        error: 'bad_request',
        message: `seconds must be a positive number of at most ${MAX_SECONDS}.`,
        issues: parsed.error.issues.map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`),
      },
      400,
    );
  }

  const { seconds = DEFAULT_SECONDS, seed = DEFAULT_SEED, lanes } = parsed.data;

  try {
    const { replay, stats } = await recordLanes({ seconds, seed, lanes });
    return json({ replay, stats }, 200);
  } catch (err) {
    return json(
      { error: 'record_failed', message: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
}

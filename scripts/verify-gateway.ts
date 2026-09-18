/**
 * Live check of everything /api/decide depends on. Read-only apart from the model
 * calls it makes (5 Jev calls + 1 per LLM lane).
 *
 *   pnpm verify:gateway
 *   # or: pnpm dlx tsx --env-file=.env.local scripts/verify-gateway.ts
 *
 * Needs Gateway auth in .env.local: AI_GATEWAY_API_KEY, or VERCEL_OIDC_TOKEN from
 * `vercel link` / `vercel env pull`. It prints the NAME of the variable in use and
 * never its value. On 401/403 (auth) or 402 (budget) it prints the exact status and
 * message and stops. It never retries.
 */
import { gateway } from '@ai-sdk/gateway';
import { APICallError } from 'ai';
import { LANES } from '../lib/game/types';
import type { DecisionState, LaneConfig } from '../lib/game/types';
import { decideWithJev } from '../lib/decide/jev';
import { decideWithLlm } from '../lib/decide/llm';
import { expectedMove } from '../lib/decide/prompt';

const JEV_SAMPLES = 5;

/** Ball heading at the right paddle, intercept well below the paddle centre. */
const SAMPLE_STATE: DecisionState = {
  court: { w: 160, h: 100 },
  ball: { x: 80, y: 42, vx: 26.67, vy: 8 },
  paddle: { y: 30, h: 20 },
  interceptY: 66,
  dir: 'toward',
};

function ms(value: number): string {
  return `${value.toFixed(0)}ms`;
}

function statusOf(err: unknown): number | undefined {
  if (APICallError.isInstance(err)) return err.statusCode;
  const status = (err as { statusCode?: unknown } | null)?.statusCode;
  return typeof status === 'number' ? status : undefined;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Auth and budget failures are terminal: report the exact status and stop. */
function fatalIfBlocked(err: unknown, where: string): void {
  const status = statusOf(err);
  if (status === 401 || status === 403 || status === 402) {
    const kind = status === 402 ? 'BUDGET' : 'AUTH';
    console.error(`\n${kind} FAILURE (${where}): HTTP ${status}`);
    console.error(`  ${messageOf(err)}`);
    if (APICallError.isInstance(err) && err.responseBody) {
      console.error(`  body: ${err.responseBody.slice(0, 400)}`);
    }
    console.error('\nStopping. Fix Gateway auth or budget, then run again.');
    process.exit(1);
  }
}

function levenshtein(a: string, b: string): number {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j += 1) rows[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);
    }
  }
  return rows[a.length][b.length];
}

/** Same provider prefix first, then smallest edit distance. */
function closest(wanted: string, ids: string[]): string | undefined {
  const provider = wanted.split('/')[0];
  const pool = ids.filter((id) => id.startsWith(`${provider}/`));
  const candidates = pool.length > 0 ? pool : ids;
  let best: string | undefined;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const id of candidates) {
    const score = levenshtein(wanted, id);
    if (score < bestScore) {
      bestScore = score;
      best = id;
    }
  }
  return best;
}

function authMode(): string {
  const modes: string[] = [];
  if (process.env.AI_GATEWAY_API_KEY) modes.push('AI_GATEWAY_API_KEY');
  if (process.env.VERCEL_OIDC_TOKEN) modes.push('VERCEL_OIDC_TOKEN');
  return modes.length > 0 ? modes.join(' + ') : 'NONE FOUND';
}

async function listModels(): Promise<Map<string, string>> {
  const { models } = await gateway.getAvailableModels();
  return new Map(models.map((m) => [m.id, m.modelType ?? 'language']));
}

async function main(): Promise<void> {
  console.log(`auth: ${authMode()} (names only; values are never printed)`);
  if (authMode() === 'NONE FOUND') {
    console.error('No Gateway credentials in the environment. Run with --env-file=.env.local.');
    process.exit(1);
  }

  // (b) Which Gateway ids actually exist.
  console.log('\n== Gateway model list ==');
  let available: Map<string, string>;
  try {
    available = await listModels();
  } catch (err) {
    fatalIfBlocked(err, 'getAvailableModels');
    console.error(`could not list models: HTTP ${statusOf(err) ?? '?'} ${messageOf(err)}`);
    process.exit(1);
  }
  const ids = [...available.keys()];
  console.log(`${ids.length} models visible.`);
  for (const lane of LANES) {
    if (lane.gateway === null) continue;
    if (available.has(lane.gateway)) {
      console.log(`  OK      ${lane.id.padEnd(7)} ${lane.gateway} (${available.get(lane.gateway)})`);
    } else {
      const suggestion = closest(lane.gateway, ids);
      console.log(
        `  MISSING ${lane.id.padEnd(7)} ${lane.gateway}` +
          (suggestion ? ` -> closest available: ${suggestion} (${available.get(suggestion)})` : ''),
      );
    }
  }

  try {
    const credits = await gateway.getCredits();
    console.log(`credits: balance ${credits.balance}, used ${credits.totalUsed}`);
  } catch (err) {
    console.log(`credits: unavailable (${messageOf(err)})`);
  }

  console.log(`\nsample state: ${JSON.stringify(SAMPLE_STATE)}`);
  console.log(`rule says: ${expectedMove(SAMPLE_STATE)}`);

  // (a) Jev, five times.
  console.log(`\n== Jev x${JEV_SAMPLES} ==`);
  const jevLatencies: number[] = [];
  for (let i = 1; i <= JEV_SAMPLES; i += 1) {
    try {
      const { move, latencyMs } = await decideWithJev(SAMPLE_STATE);
      jevLatencies.push(latencyMs);
      console.log(`  ${i}. ${ms(latencyMs).padStart(8)}  choice=${move}`);
    } catch (err) {
      fatalIfBlocked(err, 'jev');
      console.log(`  ${i}. FAILED  HTTP ${statusOf(err) ?? '?'}  ${messageOf(err)}`);
    }
  }
  if (jevLatencies.length > 0) {
    const sorted = [...jevLatencies].sort((a, b) => a - b);
    const mean = sorted.reduce((sum, v) => sum + v, 0) / sorted.length;
    console.log(`  min ${ms(sorted[0])}  median ${ms(sorted[Math.floor(sorted.length / 2)])}  max ${ms(sorted[sorted.length - 1])}  mean ${ms(mean)}`);
  }

  // (c) One call per LLM lane.
  console.log('\n== LLM lanes x1 ==');
  const llmLanes = LANES.filter((lane: LaneConfig) => lane.kind === 'structured' && lane.gateway !== null);
  for (const lane of llmLanes) {
    const id = lane.gateway as string;
    try {
      const { move, latencyMs } = await decideWithLlm(id, SAMPLE_STATE);
      console.log(`  ${lane.id.padEnd(7)} ${ms(latencyMs).padStart(8)}  move=${move}  (${id})`);
    } catch (err) {
      fatalIfBlocked(err, lane.id);
      console.log(`  ${lane.id.padEnd(7)} FAILED  HTTP ${statusOf(err) ?? '?'}  ${messageOf(err)}  (${id})`);
    }
  }
}

main().catch((err: unknown) => {
  console.error(`unexpected failure: ${messageOf(err)}`);
  process.exit(1);
});

/**
 * Re-measures public/model-comparison.json by asking the deployed app to run
 * each comparison lane from its own Vercel function (POST /api/compare), so
 * every latency is function-to-Gateway, the same footing as the lanes.
 *
 * Run (needs ADMIN_TOKEN in .env.local, the deployment's token):
 *   pnpm dlx tsx --env-file=.env.local scripts/compare-models.ts
 * Options via env: COMPARE_URL (default https://jev-pong.ably.dev),
 * LANES=jev,haiku (subset, default the published seven), N (states, default 30),
 * OUT (default public/model-comparison.json).
 */
import { writeFile } from 'node:fs/promises';
import { ADMIN_TOKEN_HEADER } from '../lib/config/admin';
import { COMPARE_LANE_KEYS, DEFAULT_STATES, type CompareRow } from '../lib/compare/compare-models';

const BASE = (process.env.COMPARE_URL ?? 'https://jev-pong.ably.dev').replace(/\/$/, '');
const PUBLISHED = ['jev', 'haiku', 'astra-fast-low', 'sol', 'astra-low', 'astra-high', 'fable-low'];
const LANES = process.env.LANES?.split(',').map((s) => s.trim()).filter(Boolean) ?? PUBLISHED;
const N = Number(process.env.N ?? DEFAULT_STATES);
const OUT = process.env.OUT ?? 'public/model-comparison.json';

async function main() {
  const token = process.env.ADMIN_TOKEN;
  if (!token) throw new Error('ADMIN_TOKEN is not set.');
  const unknown = LANES.filter((k) => !COMPARE_LANE_KEYS.includes(k));
  if (unknown.length) throw new Error(`Unknown lanes: ${unknown.join(', ')}. Known: ${COMPARE_LANE_KEYS.join(', ')}`);

  const rows: CompareRow[] = [];
  let region: string | null = null;
  for (const lane of LANES) {
    const t = Date.now();
    const res = await fetch(`${BASE}/api/compare`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [ADMIN_TOKEN_HEADER]: token },
      body: JSON.stringify({ lane, states: N }),
    });
    if (!res.ok) throw new Error(`${lane}: HTTP ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { row: CompareRow; region: string | null };
    region ??= body.region;
    rows.push(body.row);
    const r = body.row;
    console.log(
      `${lane.padEnd(16)} answered ${r.answered}/${r.states}  correct ${r.correct}/${r.answered}  p50 ${r.p50Ms} ms  p95 ${r.p95Ms} ms  (${Math.round((Date.now() - t) / 1000)} s)${r.warning ? '  WARN ' + r.warning : ''}${r.error ? '  ERR ' + r.error : ''}`,
    );
  }

  // Jev first, then fastest to slowest, which is the order the table shows.
  const [jev, ...rest] = rows;
  rest.sort((a, b) => a.p50Ms - b.p50Ms);
  const ordered = jev?.key === 'jev' ? [jev, ...rest] : rows;

  const out = {
    version: 1,
    measuredAt: new Date().toISOString().slice(0, 10),
    states: N,
    floorMs: 0,
    from: `a Vercel function in ${region ?? 'the deployment region'}, next to the Gateway`,
    region,
    rows: ordered.map(({ key, model, provider, setting, answered, correct, p50Ms, p95Ms, latenciesMs, warning, error }) => ({
      key, model, provider, setting, answered, correct, p50Ms, p95Ms, latenciesMs,
      ...(warning ? { warning } : {}),
      ...(error ? { error } : {}),
    })),
  };
  await writeFile(OUT, JSON.stringify(out, null, 2) + '\n');
  console.log(`wrote ${OUT}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

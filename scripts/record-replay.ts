/**
 * Records a real run of every demo lane against Vercel AI Gateway and writes
 * public/replay.json (the hero the home page replays) plus
 * public/replay-stats.json (the numbers we quote).
 *
 * Run (needs Gateway auth in .env.local: AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN):
 *   pnpm dlx tsx --env-file=.env.local scripts/record-replay.ts
 * Options via env: RECORD_MS (default 45000), SEED (default 20260917), LANES=jev,haiku (subset).
 *
 * The recording itself lives in lib/record/record-lanes.ts. The replay we ship
 * should be recorded from Vercel's own region (POST /api/record) so the
 * latencies are worker-to-Gateway rather than someone's home broadband; this
 * script is the same run from a laptop.
 */
import { writeFile } from 'node:fs/promises';
import type { ModelId } from '../lib/game/types';
import { recordLanes } from '../lib/record/record-lanes';

const DURATION_MS = Number(process.env.RECORD_MS ?? 45_000);
const SEED = Number(process.env.SEED ?? 20260917);
const ONLY = process.env.LANES?.split(',').map((s) => s.trim()) as ModelId[] | undefined;

async function main() {
  const { replay, stats } = await recordLanes({
    seconds: DURATION_MS / 1000,
    seed: SEED,
    lanes: ONLY,
    onProgress: ({ elapsedMs, lanes }) => {
      const line = lanes
        .map(
          (l) =>
            `${l.model} t${l.tick} ${l.score.join('-')} ${l.latencyMs ?? '-'}ms ${l.status}`,
        )
        .join(' | ');
      console.log(`${Math.round(elapsedMs / 1000)}s  ${line}`);
    },
  });

  const replayJson = JSON.stringify(replay);
  const replayOut = new URL('../public/replay.json', import.meta.url);
  await writeFile(replayOut, replayJson);

  const statsOut = new URL('../public/replay-stats.json', import.meta.url);
  await writeFile(statsOut, `${JSON.stringify(stats, null, 2)}\n`);

  console.log(`\nWrote ${replayOut.pathname} (${(replayJson.length / 1024).toFixed(0)} KB)`);
  console.log(`Wrote ${statsOut.pathname}`);
  for (const lane of stats.lanes) {
    console.log(
      `${lane.label.padEnd(18)} ticks=${String(lane.ticks).padStart(4)} ` +
        `${lane.decisionsPerSec}/s avg=${lane.avgMs}ms p95=${lane.p95Ms}ms ` +
        `returns=${lane.returns} misses=${lane.misses} ` +
        `score=${lane.finalScore.join('-')} status=${lane.status}`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

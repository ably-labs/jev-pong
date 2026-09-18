/**
 * Run ONE real game locally: real Ably, real AI Gateway, no browser.
 *
 *   pnpm worker:local -- --mode demo --model jev --seconds 60
 *   # or: pnpm dlx tsx --env-file=.env.local scripts/run-worker-local.ts --mode demo
 *
 * Needs ABLY_API_KEY in .env.local, plus Gateway auth (AI_GATEWAY_API_KEY, or
 * VERCEL_OIDC_TOKEN from `vercel link`). It prints the channel to watch, then a
 * status line every second, then the summary. `--seconds` is the deadline the
 * worker shuts down against, so the game always ends by itself.
 *
 * Nothing here is imported by the app. It exists so a human can watch a real
 * game go over a real channel before any of this is deployed.
 */

import { CHANNELS, type ModelId, type Snapshot } from '../lib/game/types';
import { runGameWorker } from '../lib/worker/game-worker';
import type { GameMode } from '../lib/worker/referee';
import { newGameId } from '../lib/ably/ids';

const MODES: readonly GameMode[] = ['vs-jev', 'vs-human', 'demo'];
const MODELS: readonly ModelId[] = ['jev', 'haiku', 'gpt', 'gemini'];

interface Args {
  mode: GameMode;
  model: ModelId;
  seconds: number;
}

function parseArgs(argv: readonly string[]): Args {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const [flag, inline] = arg.slice(2).split('=', 2);
    values.set(flag, inline ?? argv[i + 1] ?? '');
  }

  const mode = values.get('mode') ?? 'demo';
  if (!MODES.includes(mode as GameMode)) {
    throw new Error(`--mode must be one of ${MODES.join(', ')} (got "${mode}")`);
  }
  const model = values.get('model') ?? 'jev';
  if (!MODELS.includes(model as ModelId)) {
    throw new Error(`--model must be one of ${MODELS.join(', ')} (got "${model}")`);
  }
  const seconds = Number.parseInt(values.get('seconds') ?? '60', 10);
  if (!Number.isFinite(seconds) || seconds < 20) {
    throw new Error('--seconds must be a number of at least 20 (the shutdown margin is 15s)');
  }

  return { mode: mode as GameMode, model: model as ModelId, seconds };
}

function statusLine(elapsedMs: number, snapshot: Snapshot | null): string {
  const seconds = (elapsedMs / 1000).toFixed(0).padStart(3, ' ');
  if (snapshot === null) return `${seconds}s  waiting`;
  const latency = snapshot.latencyMs === null ? '   -  ' : `${Math.round(snapshot.latencyMs)}ms`;
  return (
    `${seconds}s  ${snapshot.status.padEnd(7)} ` +
    `score ${snapshot.score[0]}-${snapshot.score[1]}  tick ${String(snapshot.tick).padStart(4, ' ')}  ` +
    `ball ${snapshot.ball.x.toFixed(0)},${snapshot.ball.y.toFixed(0)}  last ${latency}`
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const ablyKey = process.env.ABLY_API_KEY;
  if (ablyKey === undefined || ablyKey === '') {
    throw new Error('ABLY_API_KEY is not set. Add it to .env.local (`vercel env pull .env.local`).');
  }

  const gameId = newGameId();
  const startedAt = Date.now();
  let latest: Snapshot | null = null;
  let finalMessage: string | null = null;
  let deciderErrors = 0;

  console.log(`game    ${gameId}`);
  console.log(`mode    ${args.mode}${args.mode === 'vs-human' ? '' : ` vs ${args.model}`}`);
  console.log(`channel ${CHANNELS.game(gameId)}`);
  console.log(`lobby   ${CHANNELS.lobby}`);
  console.log(`limit   ${args.seconds}s (ends 15s before the deadline)`);
  console.log('');

  const ticker = setInterval(() => {
    console.log(statusLine(Date.now() - startedAt, latest));
  }, 1000);

  try {
    const summary = await runGameWorker({
      gameId,
      mode: args.mode,
      model: args.model,
      ablyKey,
      deadline: new Date(startedAt + args.seconds * 1000),
      log: (message) => {
        // Transient model failures are the thing worth watching in a live run:
        // the game plays on, so they would otherwise pass unnoticed.
        if (message.startsWith('decider failed')) {
          deciderErrors += 1;
          console.log(`  !!    ${message}`);
          return;
        }
        console.log(`        ${message}`);
      },
      onState: (snapshot) => {
        latest = snapshot;
        if (snapshot.status === 'over') finalMessage = snapshot.message ?? null;
      },
    });

    console.log('');
    console.log(
      `done    ${summary.reason}  score ${summary.score[0]}-${summary.score[1]}  ` +
        `${summary.ticks} ticks in ${(summary.durationMs / 1000).toFixed(1)}s`,
    );
    console.log(`message ${finalMessage ?? summary.reason}`);
    console.log(`errors  ${deciderErrors} decider failure(s) along the way`);
  } finally {
    clearInterval(ticker);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

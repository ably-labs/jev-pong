/**
 * lib/record/record-lanes.ts — run every demo lane for real and keep the tape.
 *
 * One `LaneRunner` per model, all started at the same instant against the live
 * Vercel AI Gateway, recorded for a fixed wall-clock window. What comes back is
 * a `Replay` (what the site and the clip renderer play back) and a
 * `ReplayStats` (the numbers we quote).
 *
 * This is the whole recording, with no CLI and no filesystem, so it can run in
 * two places that need it to behave identically:
 *   - `scripts/record-replay.ts`, from a laptop;
 *   - `POST /api/record`, from a Vercel function — which is the one that
 *     matters, because the latencies then measure worker-to-Gateway rather
 *     than someone's home broadband.
 *
 * It needs Gateway auth in the environment (AI_GATEWAY_API_KEY, or
 * VERCEL_OIDC_TOKEN on a linked project).
 */

import { decide } from '../decide';
import { buildReplay, createRecorder } from '../game/replay';
import { createLaneRunner } from '../game/runner';
import {
  LANES,
  type Decider,
  type DecisionState,
  type LaneStatus,
  type ModelId,
  type Replay,
  type Snapshot,
} from '../game/types';
import { laneStats } from './stats';

/** Per-lane numbers for public/replay-stats.json and the API response. */
export interface LaneRecordStats {
  model: ModelId;
  label: string;
  /** Snapshots recorded, including the serve. */
  ticks: number;
  /** Model decisions per second of wall clock. The headline number. */
  decisionsPerSec: number;
  avgMs: number;
  p95Ms: number;
  /** Times the ball reversed at a paddle. */
  returns: number;
  /** Points conceded by either side. */
  misses: number;
  finalScore: [number, number];
  status: LaneStatus;
}

export interface ReplayStats {
  version: 1;
  recordedAt: string;
  seed: number;
  /** The window that was asked for, in seconds. */
  seconds: number;
  lanes: LaneRecordStats[];
}

/** Emitted periodically so a CLI can print a line and a route can log one. */
export interface RecordProgress {
  elapsedMs: number;
  lanes: Array<{
    model: ModelId;
    tick: number;
    score: [number, number];
    latencyMs: number | null;
    status: LaneStatus;
  }>;
}

export interface RecordLanesOptions {
  /** Wall-clock length of the recording. */
  seconds: number;
  seed: number;
  /** Subset of the demo lanes. Defaults to all of them, in contract order. */
  lanes?: ModelId[];
  onProgress?: (progress: RecordProgress) => void;
  /** How often `onProgress` fires. Default 5 s; 0 turns it off. */
  progressMs?: number;
}

function gatewayDecider(model: ModelId): Decider {
  return {
    decide: (state: DecisionState, signal?: AbortSignal) =>
      decide({ model, state, mode: 'demo' }, { signal }),
  };
}

function statsFor(
  model: ModelId,
  label: string,
  snapshots: Snapshot[],
): LaneRecordStats {
  const base = laneStats(model, label, snapshots);
  const last = snapshots[snapshots.length - 1];
  return {
    model,
    label,
    ticks: snapshots.length,
    decisionsPerSec: base.decisionsPerSecond,
    avgMs: base.avgMs,
    p95Ms: base.p95Ms,
    returns: base.returns,
    misses: base.misses,
    finalScore: last ? [last.score[0], last.score[1]] : [0, 0],
    status: last?.status ?? 'idle',
  };
}

/**
 * Record every lane for `seconds`, then stop them all and return the tape.
 *
 * Resolves only when the window has elapsed and every runner has been told to
 * stop, so the caller can write the result straight out.
 */
export async function recordLanes(
  opts: RecordLanesOptions,
): Promise<{ replay: Replay; stats: ReplayStats }> {
  const { seconds, seed, lanes: only, onProgress, progressMs = 5_000 } = opts;
  const durationMs = Math.max(0, seconds * 1000);

  const configs = LANES.filter((lane) => !only || only.includes(lane.id));
  const running = configs.map((config) => {
    const runner = createLaneRunner({
      model: config.id,
      decider: gatewayDecider(config.id),
      seed,
      leftInput: 'auto',
    });
    return { config, runner, recorder: createRecorder(runner) };
  });

  const startedAt = Date.now();
  for (const lane of running) lane.runner.start();

  const ticker =
    onProgress && progressMs > 0
      ? setInterval(() => {
          onProgress({
            elapsedMs: Date.now() - startedAt,
            lanes: running.map((lane) => {
              const latest = lane.runner.latest();
              return {
                model: lane.config.id,
                tick: latest?.tick ?? 0,
                score: latest?.score ?? [0, 0],
                latencyMs: latest?.latencyMs ?? null,
                status: latest?.status ?? 'idle',
              };
            }),
          });
        }, progressMs)
      : null;

  try {
    await new Promise((resolve) => setTimeout(resolve, durationMs));
  } finally {
    if (ticker) clearInterval(ticker);
    for (const lane of running) lane.runner.stop();
  }

  const recorded = running.map((lane) => ({
    model: lane.config.id,
    label: lane.config.label,
    snapshots: lane.recorder.stop(),
  }));

  const replay = buildReplay(recorded, seed);
  const stats: ReplayStats = {
    version: 1,
    recordedAt: replay.recordedAt,
    seed,
    seconds,
    lanes: recorded.map((lane) => statsFor(lane.model, lane.label, lane.snapshots)),
  };

  return { replay, stats };
}

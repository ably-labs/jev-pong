import { describe, expect, it } from 'vitest';
import type { DecisionState } from '../game/types';
import { expectedMove } from '../decide/prompt';
import { COMPARE_LANES, WARMUP_CALLS, compareLane, compareStates, percentile, runLane } from './compare-models';

describe('compareStates', () => {
  it('is deterministic and half toward, half away', () => {
    const a = compareStates(30);
    const b = compareStates(30);
    expect(a).toEqual(b);
    expect(a).toHaveLength(30);
    expect(a.filter((s) => s.dir === 'toward')).toHaveLength(15);
    expect(a.filter((s) => s.dir === 'away')).toHaveLength(15);
  });
});

describe('percentile', () => {
  it('uses nearest rank and copes with an empty list', () => {
    expect(percentile([5, 1, 3], 0.5)).toBe(3);
    expect(percentile([1, 2, 3, 4], 0.95)).toBe(4);
    expect(percentile([], 0.5)).toBeNaN();
  });
});

describe('runLane', () => {
  const lane = compareLane('jev')!;
  const states = compareStates(4);

  it('summarises the counted calls and skips the warm-ups', async () => {
    const seen: DecisionState[] = [];
    const row = await runLane(lane, {
      states,
      call: async (_lane, state) => {
        seen.push(state);
        const n = seen.length;
        // Warm-ups are the first WARMUP_CALLS calls; make the last counted call wrong and one fail.
        if (n === WARMUP_CALLS + states.length) return { move: null, ms: 999, error: 'boom' };
        const right = expectedMove(state);
        const move = n === WARMUP_CALLS + states.length - 1 ? (right === 'up' ? 'down' : 'up') : right;
        return { move, ms: 100 * (n - WARMUP_CALLS) };
      },
    });
    expect(seen).toHaveLength(WARMUP_CALLS + states.length);
    expect(row.states).toBe(4);
    expect(row.answered).toBe(3);
    expect(row.correct).toBe(2);
    expect(row.latenciesMs).toEqual([100, 200, 300]);
    expect(row.p50Ms).toBe(200);
    expect(row.p95Ms).toBe(300);
    expect(row.error).toBe('boom');
    expect(row.warning).toBeUndefined();
  });

  it('every lane has a distinct key and a Gateway id', () => {
    const keys = COMPARE_LANES.map((l) => l.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const l of COMPARE_LANES) expect(l.id).toMatch(/^[a-z-]+\/[a-z0-9.-]+$/);
  });
});

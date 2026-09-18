import { describe, expect, it } from 'vitest';
import { LANES } from '../game/types';
import {
  LANE_STATS,
  chatRangeSec,
  headlineSentences,
  jevAvgMs,
  resultRows,
  type LaneStat,
} from './stats';

const ROWS: LaneStat[] = [
  {
    model: 'jev',
    label: 'Jev',
    provider: 'TypeSafe AI',
    decisionsPerSec: 4.4,
    avgMs: 227.4,
    p95Ms: 400,
    returns: 25,
  },
  {
    model: 'gemini',
    label: 'Gemini',
    provider: 'Google',
    decisionsPerSec: 0.32,
    avgMs: 3167,
    p95Ms: 7438,
    returns: 2,
  },
  {
    model: 'haiku',
    label: 'Haiku',
    provider: 'Anthropic',
    decisionsPerSec: 0.4,
    avgMs: 2483,
    p95Ms: 8358,
    returns: 2,
  },
];

describe('LANE_STATS', () => {
  it('is the recorded run, in contract order', () => {
    expect(LANE_STATS.map((row) => row.model)).toEqual(LANES.map((lane) => lane.id));
  });

  it('gives Jev its provider from the gateway id, never a literal', () => {
    expect(LANE_STATS[0]?.provider).toBe('TypeSafe AI');
  });

  it('carries a real measurement for every lane', () => {
    for (const row of LANE_STATS) {
      expect(row.avgMs).toBeGreaterThan(0);
      expect(row.p95Ms).toBeGreaterThanOrEqual(row.avgMs);
      expect(row.decisionsPerSec).toBeGreaterThan(0);
    }
  });
});

describe('jevAvgMs', () => {
  it('rounds to whole milliseconds', () => {
    expect(jevAvgMs(ROWS)).toBe(227);
  });

  it('is 0 when there is no Jev lane rather than a guess', () => {
    expect(jevAvgMs(ROWS.filter((row) => row.model !== 'jev'))).toBe(0);
  });
});

describe('chatRangeSec', () => {
  it('spans the slowest and fastest chat model, one decimal', () => {
    expect(chatRangeSec(ROWS)).toEqual({ low: '2.5', high: '3.2' });
  });

  it('never counts Jev as a chat model', () => {
    const onlyJev = ROWS.filter((row) => row.model === 'jev');
    expect(chatRangeSec(onlyJev)).toEqual({ low: '0.0', high: '0.0' });
  });
});

describe('headlineSentences', () => {
  it('quotes the measurement, not a literal', () => {
    const line = headlineSentences(ROWS);
    expect(line.jevMs).toBe('227 ms');
    expect(line.chat).toBe('The chat models take 2.5 to 3.2 seconds.');
  });

  it('has no em dash and no hype', () => {
    const all = Object.values(headlineSentences()).join(' ');
    expect(all).not.toMatch(/—/);
    expect(all.toLowerCase()).not.toMatch(/revolutionary|game-?chang|blazing/);
  });
});

describe('resultRows', () => {
  it('adds the counted window to each lane', () => {
    const rows = resultRows({ jev: 53, gemini: 4 }, ROWS);
    expect(rows.map((row) => row.inWindow)).toEqual([53, 4, 0]);
  });
});

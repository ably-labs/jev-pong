import { describe, expect, it } from 'vitest';
import { COMPARISON_STATES, accuracyPercent, comparisonRows } from './comparison';

describe('comparisonRows', () => {
  it('puts Jev first at exactly 1x and every other model at 1x or slower', () => {
    const rows = comparisonRows();
    expect(rows[0].model).toBe('Jev');
    expect(rows[0].timesJev).toBe(1);
    for (const row of rows.slice(1)) expect(row.timesJev).toBeGreaterThanOrEqual(1);
  });

  it('removes the local floor from every median and never goes below zero', () => {
    const rows = comparisonRows(
      [
        { model: 'Jev', provider: 'x', setting: 's', answered: 30, correct: 30, p50Ms: 300, p95Ms: 400 },
        { model: 'Slow', provider: 'x', setting: 's', answered: 30, correct: 30, p50Ms: 1500, p95Ms: 2000 },
        { model: 'Faster than the floor', provider: 'x', setting: 's', answered: 30, correct: 30, p50Ms: 50, p95Ms: 60 },
      ],
      120,
    );
    expect(rows[0].adjustedP50Ms).toBe(180);
    expect(rows[1].adjustedP50Ms).toBe(1380);
    expect(rows[1].timesJev).toBe(7.7);
    expect(rows[2].adjustedP50Ms).toBe(0);
  });

  it('never lets a model answer more states than the run had', () => {
    for (const row of comparisonRows()) {
      expect(row.answered).toBeLessThanOrEqual(COMPARISON_STATES);
      expect(row.correct).toBeLessThanOrEqual(row.answered);
    }
  });

  it('reports accuracy as a whole percentage of the answers given', () => {
    expect(accuracyPercent({ answered: 30, correct: 29 })).toBe(97);
    expect(accuracyPercent({ answered: 0, correct: 0 })).toBe(0);
  });
});

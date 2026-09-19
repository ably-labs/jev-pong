import { describe, expect, it } from 'vitest';
import { COMPARISON_STATES, accuracyPercent, comparisonRows, accuracySentence } from './comparison';

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

describe('accuracySentence', () => {
  const row = (model: string, answered: number, correct: number) => ({ model, answered, correct });

  it('says every chat model was right and how many Jev missed', () => {
    expect(accuracySentence([row('Jev', 30, 29), row('A', 30, 30), row('B', 30, 30)], 30)).toBe(
      'Every chat model answered all 30 correctly; Jev missed one.',
    );
    expect(accuracySentence([row('Jev', 30, 30), row('A', 30, 30)], 30)).toBe(
      'Every chat model answered all 30 correctly; so did Jev.',
    );
    expect(accuracySentence([row('Jev', 30, 27), row('A', 30, 30)], 30)).toBe(
      'Every chat model answered all 30 correctly; Jev missed 3.',
    );
  });

  it('totals the chat models when one of them slipped', () => {
    expect(accuracySentence([row('Jev', 30, 30), row('A', 30, 29), row('B', 30, 30)], 30)).toBe(
      'The chat models answered 59 of 60 correctly between them; so did Jev.',
    );
  });

  it('mentions calls that got no answer', () => {
    expect(accuracySentence([row('Jev', 29, 28), row('A', 30, 30)], 30)).toBe(
      'Every chat model answered all 30 correctly; Jev missed one. Jev got no answer to one call, which is not counted.',
    );
    expect(accuracySentence([row('Jev', 30, 30), row('A', 28, 28)], 30)).toBe(
      'Every chat model answered all 28 correctly; so did Jev. A got no answer to 2 calls, which are not counted.',
    );
  });

  it('is empty without Jev or without a chat model', () => {
    expect(accuracySentence([row('A', 30, 30)])).toBe('');
    expect(accuracySentence([row('Jev', 30, 30)])).toBe('');
  });
});

describe('adjustedP95Ms', () => {
  it('removes the floor from p95 as well', () => {
    const rows = comparisonRows(
      [
        { model: 'Jev', provider: 'x', setting: 'y', answered: 1, correct: 1, p50Ms: 300, p95Ms: 500 },
        { model: 'A', provider: 'x', setting: 'y', answered: 1, correct: 1, p50Ms: 1000, p95Ms: 1200 },
      ],
      100,
    );
    expect(rows.map((r) => r.adjustedP95Ms)).toEqual([400, 1100]);
  });
});

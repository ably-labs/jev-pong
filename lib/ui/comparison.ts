/**
 * lib/ui/comparison.ts — the "other models, same question" addendum.
 *
 * The four lanes on the home page are a recording taken next to the Gateway
 * and are deliberately the four models everyone knows. After launch, people
 * asked about the newest frontier models, so the same question was put to
 * them too: the same 125-byte state, the same instruction and three answers,
 * one call per decision, sequential (lib/compare). That run lives in
 * `public/model-comparison.json`, measured from a Vercel function next to the
 * Gateway by `scripts/compare-models.ts`, with where and when recorded beside
 * the numbers. This file derives the columns a reader wants. Nothing here is
 * typed in by hand.
 *
 * `floorMs` is the per-request overhead of wherever the run was made, to be
 * removed before comparing. From Vercel it is 0 and the adjusted figures are
 * the raw ones; it exists so a run made from a laptop can say so honestly
 * rather than publish its broadband as the model's latency.
 */

import comparison from '../../public/model-comparison.json';

/** One row as `public/model-comparison.json` stores it. */
export interface ComparisonSourceRow {
  model: string;
  provider: string;
  setting: string;
  answered: number;
  correct: number;
  p50Ms: number;
  p95Ms: number;
  key?: string;
  latenciesMs?: number[];
  warning?: string;
  error?: string;
}

export interface ComparisonRow extends ComparisonSourceRow {
  /** Median and p95 with the floor removed; from Vercel the floor is 0. */
  adjustedP50Ms: number;
  adjustedP95Ms: number;
  /** adjustedP50Ms over Jev's, one decimal. Jev is 1. */
  timesJev: number;
}

export const COMPARISON_STATES: number = comparison.states;
export const COMPARISON_FLOOR_MS: number = comparison.floorMs;
export const COMPARISON_MEASURED_AT: string = comparison.measuredAt;
export const COMPARISON_FROM: string = comparison.from;

/** Rows in the order the file lists them (Jev first, then fastest to slowest). */
export function comparisonRows(
  rows: readonly ComparisonSourceRow[] = comparison.rows,
  floorMs: number = comparison.floorMs,
): ComparisonRow[] {
  const jev = rows.find((r) => r.model === 'Jev');
  const jevAdjusted = Math.max(1, (jev?.p50Ms ?? 0) - floorMs);
  return rows.map((r) => {
    const adjustedP50Ms = Math.max(0, r.p50Ms - floorMs);
    return {
      ...r,
      adjustedP50Ms,
      adjustedP95Ms: Math.max(0, r.p95Ms - floorMs),
      timesJev: Math.round((Math.max(1, adjustedP50Ms) / jevAdjusted) * 10) / 10,
    };
  });
}

/** "29 of 30" as a percentage for the table. */
export function accuracyPercent(row: Pick<ComparisonRow, 'answered' | 'correct'>): number {
  return row.answered === 0 ? 0 : Math.round((100 * row.correct) / row.answered);
}

/**
 * The sentence under the table about who got the question right, built from
 * the rows so it cannot drift from them. Jev is the first row. A model that
 * got no answer to a call (a Gateway error) is said so, because the table
 * then shows fewer than `states` answers for it.
 */
export function accuracySentence(
  rows: readonly Pick<ComparisonRow, 'model' | 'answered' | 'correct'>[],
  states: number = COMPARISON_STATES,
): string {
  const jev = rows.find((r) => r.model === 'Jev');
  const others = rows.filter((r) => r.model !== 'Jev');
  if (jev === undefined || others.length === 0) return '';
  const unanswered = rows
    .filter((r) => r.answered < states)
    .map((r) => `${r.model} got no answer to ${plural(states - r.answered, 'call')}, which ${states - r.answered === 1 ? 'is' : 'are'} not counted`);
  const allRight = others.every((r) => r.correct === r.answered);
  const chat = allRight
    ? `Every chat model answered all ${others[0].answered} correctly`
    : `The chat models answered ${others.reduce((n, r) => n + r.correct, 0)} of ${others.reduce((n, r) => n + r.answered, 0)} correctly between them`;
  const missed = jev.answered - jev.correct;
  const jevPart = missed === 0 ? 'so did Jev' : missed === 1 ? 'Jev missed one' : `Jev missed ${missed}`;
  return [`${chat}; ${jevPart}.`, ...unanswered.map((u) => `${u}.`)].join(' ');
}

function plural(n: number, noun: string): string {
  return n === 1 ? `one ${noun}` : `${n} ${noun}s`;
}

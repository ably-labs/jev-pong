/**
 * lib/ui/comparison.ts — the "other models, same question" addendum.
 *
 * The four lanes on the home page are a recording taken next to the Gateway
 * and are deliberately the four models everyone knows. After launch, people
 * asked about the newest frontier models, so the same question was put to
 * them too: the same 125-byte state, the same instruction and three answers,
 * one call per decision, sequential. That run lives in
 * `public/model-comparison.json`, with how it was measured recorded beside the
 * numbers, and this file derives the two columns a reader wants: the median
 * with the local network floor removed, and how many times slower than Jev
 * that makes each model. Nothing here is typed in by hand.
 *
 * Why a floor: that run was made from a laptop, not from Vercel, so every
 * number carries the same laptop-to-Gateway request overhead (measured with
 * curl over a kept-alive connection). Removing it puts the figures on the
 * same footing as the lanes; Jev's adjusted median matches its Vercel-side
 * figure within the run-to-run noise. The ratios are what matter.
 */

import comparison from '../../public/model-comparison.json';

export interface ComparisonRow {
  model: string;
  provider: string;
  setting: string;
  answered: number;
  correct: number;
  p50Ms: number;
  p95Ms: number;
  /** Median with the local floor removed. */
  adjustedP50Ms: number;
  /** adjustedP50Ms over Jev's, one decimal. Jev is 1. */
  timesJev: number;
}

export const COMPARISON_STATES: number = comparison.states;
export const COMPARISON_FLOOR_MS: number = comparison.floorMs;
export const COMPARISON_MEASURED_AT: string = comparison.measuredAt;
export const COMPARISON_FROM: string = comparison.from;

/** Rows in the order the file lists them (Jev first, then fastest to slowest). */
export function comparisonRows(
  rows: typeof comparison.rows = comparison.rows,
  floorMs: number = comparison.floorMs,
): ComparisonRow[] {
  const jev = rows.find((r) => r.model === 'Jev');
  const jevAdjusted = Math.max(1, (jev?.p50Ms ?? 0) - floorMs);
  return rows.map((r) => {
    const adjustedP50Ms = Math.max(0, r.p50Ms - floorMs);
    return {
      ...r,
      adjustedP50Ms,
      timesJev: Math.round((Math.max(1, adjustedP50Ms) / jevAdjusted) * 10) / 10,
    };
  });
}

/** "29 of 30" as a percentage for the table. */
export function accuracyPercent(row: Pick<ComparisonRow, 'answered' | 'correct'>): number {
  return row.answered === 0 ? 0 : Math.round((100 * row.correct) / row.answered);
}

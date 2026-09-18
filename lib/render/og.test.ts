import { describe, expect, it } from 'vitest';
import { CLIP_SECONDS } from '../config/site';
import { LANES } from '../game/types';
import { endCardRows } from './frame';
import { OG_REPLAY, ogRows } from './og';
import { createReplayTimeline } from './timeline';
import { CLIP_TOKENS } from './tokens';

/**
 * The social card and the clip's end card must show one set of numbers. They
 * are drawn by different code (Satori vs canvas), so the guard is that both
 * count through the same function over the same window.
 */
describe('og numbers', () => {
  it('agrees with the clip end card on the recorded replay', () => {
    // Exactly the call drawFrame makes for a clip started at 0 (lib/render/frame.ts).
    const clip = endCardRows(
      OG_REPLAY,
      createReplayTimeline(OG_REPLAY).lanes,
      0,
      CLIP_SECONDS * 1000,
    );

    expect(ogRows()).toEqual(clip);
  });

  it('counts real decisions from the replay, in lane order', () => {
    const rows = ogRows();

    expect(rows.map((row) => row.model)).toEqual(LANES.map((lane) => lane.id));
    expect(rows.every((row) => Number.isInteger(row.decisions) && row.decisions >= 0)).toBe(true);

    // The one claim the card makes: Jev gets the most decisions in the window.
    const jev = rows.find((row) => row.model === 'jev');
    expect(jev?.decisions).toBeGreaterThan(0);
    expect(Math.max(...rows.map((row) => row.decisions))).toBe(jev?.decisions);
  });

  // app/opengraph-image.tsx repeats this path as a literal, because the
  // bundler has to be able to read it. Keep the two in step.
  it('draws the wordmark the clip renderer uses', () => {
    expect(CLIP_TOKENS.logo.darkBg).toBe('public/brand/ably-logo-horizontal-dark-bg.svg');
  });
});

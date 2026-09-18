import { describe, expect, it } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { SEGMENT_X, type ModelId, type Replay, type Snapshot } from '../game/types';
import {
  clipDurationMs,
  clipPhaseAt,
  countsLine,
  drawFrame,
  endCardRows,
  layoutFrame,
} from './frame';
import { createReplayTimeline } from './timeline';
import { CLIP_TOKENS, type ClipLayout } from './tokens';

const LAYOUTS: ClipLayout[] = ['wide', 'square'];

/** A lane whose ball crosses at a fixed pace. Enough to exercise every path. */
function lane(model: ModelId, label: string, latencyMs: number, ticks: number) {
  const snapshots: Snapshot[] = [];
  let x = 80;
  let vx = SEGMENT_X;
  for (let i = 0; i <= ticks; i += 1) {
    snapshots.push({
      t: i * latencyMs,
      tick: i,
      seed: 1,
      ball: { x, y: 40 + (i % 7) * 4, vx, vy: 3 },
      leftY: 45 + (i % 3) * 5,
      rightY: 50 + (i % 4) * 4,
      score: [Math.floor(i / 20), 0],
      model,
      latencyMs: i === 0 ? null : latencyMs,
      move: 'stay',
      status: i === 0 ? 'serving' : 'playing',
    });
    x += vx;
    if (x >= 160 || x <= 0) vx = -vx;
  }
  return { model, label, snapshots };
}

const REPLAY: Replay = {
  version: 1,
  recordedAt: '2026-09-17T00:00:00.000Z',
  seed: 1,
  lanes: [
    lane('jev', 'Jev', 110, 90),
    lane('gemini', 'Gemini 3.8 Flash', 1500, 7),
    lane('haiku', 'Claude Haiku 4.5', 940, 11),
    lane('gpt', 'GPT-5.6 Sol', 2400, 4),
  ],
};

/** How much of the canvas is not the page background — i.e. did we draw? */
function inkFraction(data: Uint8Array | Buffer, page: [number, number, number]): number {
  let ink = 0;
  let total = 0;
  for (let i = 0; i < data.length; i += 4 * 97) {
    total += 1;
    const dr = Math.abs(data[i] - page[0]);
    const dg = Math.abs(data[i + 1] - page[1]);
    const db = Math.abs(data[i + 2] - page[2]);
    if (dr + dg + db > 24) ink += 1;
  }
  return total === 0 ? 0 : ink / total;
}

const GROUND: [number, number, number] = [0x0a, 0x0b, 0x0f];

describe('layoutFrame', () => {
  it.each(LAYOUTS)('keeps every box inside the frame (%s)', (layout) => {
    const l = layoutFrame(CLIP_TOKENS, layout, 4);
    const s = CLIP_TOKENS.sizes[layout];

    expect(l.lanes).toHaveLength(4);
    expect(l.content.x + l.content.w).toBeLessThanOrEqual(s.width);
    expect(l.strip.y + l.strip.h).toBeLessThanOrEqual(s.height);

    for (const boxes of l.lanes) {
      // Courts sit between the header and the credit strip.
      expect(boxes.court.y).toBeGreaterThanOrEqual(l.header.y + l.header.h);
      expect(boxes.court.y + boxes.court.h).toBeLessThanOrEqual(l.strip.y);
      expect(boxes.court.w).toBe(s.courtW);
      expect(boxes.court.h).toBe(s.courtH);
      if (s.laneMode === 'row') {
        // The three columns must not overlap, in either direction.
        expect(boxes.name.x + boxes.name.w).toBeLessThanOrEqual(boxes.court.x);
        expect(boxes.court.x + boxes.court.w).toBeLessThanOrEqual(boxes.number.x);
        expect(boxes.number.x + boxes.number.w).toBeLessThanOrEqual(s.width - s.padX + 0.5);
      }
    }

    // Rows stack in order, with the declared gap and no overlap.
    for (let i = 1; i < l.lanes.length; i += 1) {
      expect(l.lanes[i].row.y).toBeGreaterThan(l.lanes[i - 1].row.y);
      expect(l.lanes[i].court.y).toBeGreaterThanOrEqual(
        l.lanes[i - 1].court.y + l.lanes[i - 1].court.h,
      );
    }
  });

  it('survives a replay with no lanes', () => {
    expect(layoutFrame(CLIP_TOKENS, 'wide', 0).lanes).toHaveLength(0);
  });
});

describe('clip timing (motion note 07)', () => {
  const end = { playMs: 12_000, fromMs: 0 };
  const m = CLIP_TOKENS.motion;

  it('is 15.2 s for twelve seconds of play', () => {
    expect(clipDurationMs(12_000)).toBe(15_200);
  });

  it('freezes, then cross-fades, then grows the bars', () => {
    expect(clipPhaseAt(11_000, end)).toMatchObject({ courtTimeMs: 11_000, endCardAlpha: 0 });

    const frozen = clipPhaseAt(12_200, end);
    expect(frozen.courtTimeMs).toBe(12_000);
    expect(frozen.endCardAlpha).toBe(0);

    const fading = clipPhaseAt(12_000 + m.freezeMs + m.crossFadeMs / 2, end);
    expect(fading.endCardAlpha).toBeCloseTo(0.5, 6);
    expect(fading.barsSinceMs).toBeLessThan(0);

    const shown = clipPhaseAt(12_000 + m.freezeMs + m.crossFadeMs + 100, end);
    expect(shown.endCardAlpha).toBe(1);
    expect(shown.barsSinceMs).toBeCloseTo(100, 6);
  });

  it('does nothing at all without an end card', () => {
    expect(clipPhaseAt(99_000, undefined)).toEqual({
      courtTimeMs: 99_000,
      endCardAlpha: 0,
      barsSinceMs: -1,
    });
  });
});

describe('drawFrame', () => {
  it.each(LAYOUTS)('renders without throwing and puts ink on the ground (%s)', (layout) => {
    const s = CLIP_TOKENS.sizes[layout];
    const canvas = createCanvas(s.width, s.height);
    const ctx = canvas.getContext('2d');

    for (const tMs of [0, 1, 2_000, 5_000, 11_999]) {
      expect(() => drawFrame(ctx, REPLAY, tMs, layout, CLIP_TOKENS)).not.toThrow();
    }

    expect(canvas.width).toBe(s.width);
    expect(canvas.height).toBe(s.height);
    // Four courts, four names and four numbers are well over a tenth of it.
    expect(inkFraction(canvas.data(), GROUND)).toBeGreaterThan(0.1);
  });

  it.each(LAYOUTS)('renders the end card without throwing (%s)', (layout) => {
    const s = CLIP_TOKENS.sizes[layout];
    const canvas = createCanvas(s.width, s.height);
    const ctx = canvas.getContext('2d');
    const endCard = { playMs: 12_000, fromMs: 0 };

    for (const tMs of [12_000, 12_500, 13_000, 15_199]) {
      expect(() => drawFrame(ctx, REPLAY, tMs, layout, CLIP_TOKENS, { endCard })).not.toThrow();
    }

    // The end card replaces the courts, so there is much less ink than a live
    // frame — but the headline, the bars and the strip are still there.
    const ink = inkFraction(canvas.data(), GROUND);
    expect(ink).toBeGreaterThan(0);
    expect(ink).toBeLessThan(0.2);
  });

  it('draws the wordmark as text when no logo image is supplied', () => {
    const canvas = createCanvas(1200, 675);
    const ctx = canvas.getContext('2d');
    expect(() => drawFrame(ctx, REPLAY, 2_000, 'wide', CLIP_TOKENS, { logo: null })).not.toThrow();
  });

  it('accepts prebuilt timelines and a URL override', () => {
    const canvas = createCanvas(1200, 675);
    const ctx = canvas.getContext('2d');
    const timelines = createReplayTimeline(REPLAY, CLIP_TOKENS).lanes;
    expect(() =>
      drawFrame(ctx, REPLAY, 13_500, 'wide', CLIP_TOKENS, {
        timelines,
        url: 'example.test',
        endCard: { playMs: 12_000, fromMs: 0 },
      }),
    ).not.toThrow();
  });

  it('renders a replay with no lanes at all', () => {
    const canvas = createCanvas(1200, 675);
    const ctx = canvas.getContext('2d');
    const empty: Replay = { ...REPLAY, lanes: [] };
    expect(() => drawFrame(ctx, empty, 1_000, 'wide', CLIP_TOKENS)).not.toThrow();
  });
});

describe('endCardRows', () => {
  it('keeps the lanes in contract order and counts decisions in the window', () => {
    const timelines = createReplayTimeline(REPLAY, CLIP_TOKENS).lanes;
    const rows = endCardRows(REPLAY, timelines, 0, 12_000);

    expect(rows.map((r) => r.model)).toEqual(['jev', 'gemini', 'haiku', 'gpt']);
    // The fastest lane must out-decide the slowest — the whole point of the clip.
    expect(rows[0].decisions).toBeGreaterThan(rows[3].decisions);
    // 110 ms a decision for twelve seconds, capped by the recording's length.
    expect(rows[0].decisions).toBe(90);
    expect(rows[3].decisions).toBe(4);
    expect(rows[0].gateway).toBe('typesafe-ai/jev');
  });
});

describe('countsLine', () => {
  it('gets the singular right', () => {
    expect(countsLine(0, 0)).toBe('0 decisions · 0 returns');
    expect(countsLine(1, 1)).toBe('1 decision · 1 return');
    expect(countsLine(5, 2)).toBe('5 decisions · 2 returns');
  });
});

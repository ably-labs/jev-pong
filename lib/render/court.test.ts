import { describe, expect, it } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { COURT_H, COURT_W, PADDLE_H, RIGHT_PLANE } from '../game/types';
import {
  COURT_SIZES,
  courtStyle,
  drawCourt,
  homeSurfaceFor,
  trailLength,
  trailSpans,
  type CourtTheme,
  type CourtView,
} from './court';
import { CLIP_TOKENS } from './tokens';

const THEME: CourtTheme = {
  court: '#12141A',
  hair: 'rgba(255,255,255,0.08)',
  courtLine: 'rgba(255,255,255,0.16)',
  paddle: '#E7E9EE',
  ball: '#FF5416',
  fgMuted: '#8B909B',
};

const VIEW: CourtView = {
  ballX: 100,
  ballY: 40,
  leftY: 45,
  rightY: 55,
  trail: [
    { x: 96, y: 41 },
    { x: 90, y: 42 },
    { x: 83, y: 43 },
  ],
  score: [2, 4],
};

describe('trailSpans', () => {
  it('ends exactly at the requested length', () => {
    const spans = trailSpans(260, 7, 1.12);
    expect(spans).toHaveLength(7);
    expect(spans[spans.length - 1]).toBeCloseTo(260, 6);
  });

  it('spaces each disc 12% further back than the last', () => {
    const spans = trailSpans(100, 5, 1.12);
    const gaps = spans.map((s, i) => (i === 0 ? s : s - spans[i - 1]));
    for (let i = 1; i < gaps.length; i += 1) {
      expect(gaps[i] / gaps[i - 1]).toBeCloseTo(1.12, 6);
    }
  });

  it('returns nothing for a zero-length or disc-less trail', () => {
    expect(trailSpans(0, 5, 1.12)).toEqual([]);
    expect(trailSpans(100, 0, 1.12)).toEqual([]);
  });
});

describe('trailLength', () => {
  const trail = CLIP_TOKENS.trail;

  it('is full length at the reference latency and shorter above it', () => {
    expect(trailLength(260, 430, trail)).toBeCloseTo(260, 6);
    expect(trailLength(260, 860, trail)).toBeCloseTo(130, 6);
    // A fast lane streaks, a slow one barely smears — that is the whole read.
    expect(trailLength(260, 100, trail)).toBe(260);
    expect(trailLength(260, 4000, trail)).toBeCloseTo(27.95, 6);
  });

  it('clamps to the floor and never below it', () => {
    expect(trailLength(260, 60_000, trail)).toBeCloseTo(24, 6);
    expect(trailLength(260, null, trail)).toBe(260);
  });
});

describe('courtStyle', () => {
  // paddleH and paddleInset used to be scaled here. They are gone: drawCourt
  // derives the bar's height from PADDLE_H and its x from the paddle planes, so
  // the bar cannot drift away from the hitbox at any size.
  it('scales the whole size-table row by the width it is given', () => {
    const full = courtStyle('home-desktop', 704, THEME, 430);
    const half = courtStyle('home-desktop', 352, THEME, 430);
    expect(full.ballR).toBeCloseTo(4.5, 6);
    expect(half.ballR).toBeCloseTo(2.25, 6);
    expect(half.paddleW).toBeCloseTo(2, 6);
    expect(half.radius).toBeCloseTo(3, 6);
  });

  it('gives the court its tokens and one span per disc', () => {
    const style = courtStyle('clip-wide', 640, THEME, 430, CLIP_TOKENS);
    expect(style.bed).toBe(THEME.court);
    expect(style.paddle).toBe(THEME.paddle);
    expect(style.ball).toBe(THEME.ball);
    expect(style.trail.spans).toHaveLength(COURT_SIZES['clip-wide'].discs);
    // Spans are in COURT units, because the view's trail is.
    const last = style.trail.spans[style.trail.spans.length - 1];
    expect(last).toBeCloseTo((260 / 640) * COURT_W, 6);
  });

  it('only gives a score to the surfaces that show one', () => {
    expect(courtStyle('play', 704, THEME, 400).score).not.toBeNull();
    expect(courtStyle('home-desktop', 704, THEME, 400).score).toBeNull();
  });
});

describe('homeSurfaceFor', () => {
  it('switches on the width the court is actually drawn at', () => {
    expect(homeSurfaceFor(704)).toBe('home-desktop');
    expect(homeSurfaceFor(520)).toBe('home-desktop');
    expect(homeSurfaceFor(519)).toBe('home-phone');
    expect(homeSurfaceFor(358)).toBe('home-phone');
  });
});

describe('drawCourt', () => {
  it('paints inside its box and nowhere else', () => {
    const canvas = createCanvas(400, 200);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, 400, 200);

    const style = courtStyle('home-desktop', 300, THEME, 430);
    drawCourt(ctx, VIEW, { x: 50, y: 50, w: 300, h: 34 }, style);

    const data = canvas.data();
    const at = (x: number, y: number) => {
      const i = (y * 400 + x) * 4;
      return [data[i], data[i + 1], data[i + 2]];
    };
    // Outside the box it is still the black we painted.
    expect(at(10, 10)).toEqual([0, 0, 0]);
    expect(at(390, 190)).toEqual([0, 0, 0]);
    // Inside it is the court bed.
    expect(at(200, 60)).toEqual([0x12, 0x14, 0x1a]);
  });

  it('puts the paddle bar exactly on the plane the ball turns at', () => {
    // The whole point of the geometry fix: the drawn bar IS the hitbox, and its
    // inner face is the plane. Read the pixels rather than trusting the maths.
    const w = 640;
    const h = 100;
    const canvas = createCanvas(w, h);
    const ctx = canvas.getContext('2d');
    const style = courtStyle('clip-wide', w, THEME, 430);
    const centred: CourtView = { ...VIEW, leftY: 50, rightY: 50, trail: [], ballHidden: true };
    drawCourt(ctx, centred, { x: 0, y: 0, w, h }, style);

    const data = canvas.data();
    const isPaddle = (x: number, y: number): boolean => {
      const i = (y * w + x) * 4;
      // #E7E9EE, the paddle colour, against the #12141A bed.
      return data[i] === 0xe7 && data[i + 1] === 0xe9 && data[i + 2] === 0xee;
    };

    const planePx = Math.round((RIGHT_PLANE / COURT_W) * w); // 624 of 640
    // Paddle just OUTSIDE the plane (toward the edge); open court just inside
    // it, where the ball travels. The ball can never reach the paddle's pixels.
    expect(isPaddle(planePx + 1, h / 2)).toBe(true);
    expect(isPaddle(planePx - 2, h / 2)).toBe(false);

    // And the bar is PADDLE_H tall, in court units: 20 of 100 = 20px here.
    let painted = 0;
    for (let y = 0; y < h; y += 1) if (isPaddle(planePx + 1, y)) painted += 1;
    const expected = PADDLE_H * (h / COURT_H);
    expect(Math.abs(painted - expected)).toBeLessThanOrEqual(2);
  });

  it('draws nothing for a degenerate box', () => {
    const canvas = createCanvas(10, 10);
    const ctx = canvas.getContext('2d');
    const style = courtStyle('watch', 358, THEME, 400);
    expect(() => drawCourt(ctx, VIEW, { x: 0, y: 0, w: 0, h: 0 }, style)).not.toThrow();
  });

  it('survives an empty trail, a hidden ball and a score', () => {
    const canvas = createCanvas(400, 300);
    const ctx = canvas.getContext('2d');
    const style = courtStyle('play', 400, THEME, 400);
    const empty: CourtView = {
      ballX: COURT_W / 2,
      ballY: COURT_H / 2,
      leftY: 50,
      rightY: 50,
      trail: [],
      score: [0, 0],
      ballHidden: true,
    };
    expect(() => drawCourt(ctx, empty, { x: 0, y: 0, w: 400, h: 170 }, style)).not.toThrow();
  });
});

import { describe, expect, it } from 'vitest';
import {
  playOverlay,
  POINT_FLASH_MS,
  resultText,
  serveCount,
  SERVE_COUNTDOWN_MS,
  type PlayOverlayInput,
} from './play-overlay';

const QUIET: PlayOverlayInput = {
  status: 'playing',
  score: [0, 0],
  servingForMs: null,
  pointAgeMs: null,
  pointTo: null,
  opponent: 'Jev',
};

describe('serveCount', () => {
  it('counts three down to none over the serve pause', () => {
    expect(serveCount(0)).toBe(3);
    expect(serveCount(SERVE_COUNTDOWN_MS / 3 - 1)).toBe(3);
    expect(serveCount(SERVE_COUNTDOWN_MS / 2)).toBe(2);
    expect(serveCount(SERVE_COUNTDOWN_MS - 1)).toBe(1);
    expect(serveCount(SERVE_COUNTDOWN_MS)).toBe(0);
    expect(serveCount(SERVE_COUNTDOWN_MS + 5000)).toBe(0);
  });

  it('still counts three numbers if the pause changes', () => {
    expect(serveCount(0, 900)).toBe(3);
    expect(serveCount(600, 900)).toBe(1);
    expect(serveCount(900, 900)).toBe(0);
    expect(serveCount(10, 0)).toBe(0);
  });

  it('treats a negative elapsed as not started', () => {
    expect(serveCount(-100)).toBe(3);
  });
});

describe('playOverlay', () => {
  it('says nothing during ordinary play', () => {
    expect(playOverlay(QUIET)).toEqual({ kind: 'none' });
  });

  it('counts the first serve in', () => {
    const overlay = playOverlay({ ...QUIET, status: 'serving', servingForMs: 0 });
    expect(overlay).toEqual({
      kind: 'countdown',
      count: 3,
      title: 'Get ready',
      hint: '↑ ↓ to move',
    });
  });

  it('only counts in the first serve of the game', () => {
    const later = playOverlay({
      ...QUIET,
      status: 'serving',
      servingForMs: 0,
      score: [1, 0],
    });
    expect(later).toEqual({ kind: 'none' });
  });

  it('stops counting once the serve is due', () => {
    const overlay = playOverlay({
      ...QUIET,
      status: 'serving',
      servingForMs: SERVE_COUNTDOWN_MS,
    });
    expect(overlay).toEqual({ kind: 'none' });
  });

  it('flashes who took the point, briefly', () => {
    expect(playOverlay({ ...QUIET, pointTo: 'you', pointAgeMs: 0 })).toEqual({
      kind: 'point',
      title: 'Point to you',
    });
    expect(playOverlay({ ...QUIET, pointTo: 'them', pointAgeMs: 200 })).toEqual({
      kind: 'point',
      title: 'Point to Jev',
    });
    expect(playOverlay({ ...QUIET, pointTo: 'them', pointAgeMs: POINT_FLASH_MS })).toEqual({
      kind: 'none',
    });
  });

  it('shows the scoreline when the game is over', () => {
    expect(playOverlay({ ...QUIET, status: 'over', score: [2, 5] })).toEqual({
      kind: 'over',
      title: 'Jev won 5–2',
      youWon: false,
    });
    expect(playOverlay({ ...QUIET, status: 'over', score: [5, 3] })).toEqual({
      kind: 'over',
      title: 'You won 5–3',
      youWon: true,
    });
  });

  it('outranks a point flash and a countdown when the game ends', () => {
    const overlay = playOverlay({
      ...QUIET,
      status: 'over',
      score: [5, 4],
      pointTo: 'you',
      pointAgeMs: 0,
      servingForMs: 0,
    });
    expect(overlay.kind).toBe('over');
  });

  it('names the ways a game can stop without a winner', () => {
    expect(playOverlay({ ...QUIET, status: 'credits' })).toEqual({
      kind: 'over',
      title: 'Out of credits',
      youWon: false,
    });
    expect(playOverlay({ ...QUIET, status: 'error' })).toEqual({
      kind: 'over',
      title: 'The game stopped',
      youWon: false,
    });
  });
});

describe('resultText', () => {
  it('reads the higher score first, whoever it belongs to', () => {
    expect(resultText([5, 2], 'Jev')).toEqual({ title: 'You won 5–2', youWon: true });
    expect(resultText([0, 5], 'Jev')).toEqual({ title: 'Jev won 5–0', youWon: false });
    expect(resultText([3, 3], 'Jev')).toEqual({
      title: 'Stopped at 3–3',
      youWon: false,
    });
  });
});

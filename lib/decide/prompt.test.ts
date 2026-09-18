import { describe, expect, it } from 'vitest';
import type { DecisionState } from '../game/types';
import {
  DECISION_INSTRUCTIONS,
  LLM_SYSTEM_PROMPT,
  MOVE_CRITERIA,
  MOVES,
  STAY_TOLERANCE,
  expectedMove,
  isMove,
  stateForModel,
} from './prompt';

function state(overrides: Partial<DecisionState> = {}): DecisionState {
  return {
    court: { w: 160, h: 100 },
    ball: { x: 80, y: 50, vx: 26.67, vy: 8 },
    paddle: { y: 50, h: 20 },
    interceptY: 50,
    dir: 'toward',
    ...overrides,
  };
}

describe('expectedMove', () => {
  it('stays when the ball is moving away and there is no intercept', () => {
    expect(expectedMove(state({ interceptY: null, dir: 'away' }))).toBe('stay');
  });

  it('stays inside the tolerance band, on both sides and at the edge', () => {
    expect(expectedMove(state({ paddle: { y: 50, h: 20 }, interceptY: 50 }))).toBe('stay');
    expect(expectedMove(state({ paddle: { y: 50, h: 20 }, interceptY: 55 }))).toBe('stay');
    expect(expectedMove(state({ paddle: { y: 50, h: 20 }, interceptY: 45 }))).toBe('stay');
  });

  it('moves up when the intercept is above the paddle centre (smaller y)', () => {
    expect(expectedMove(state({ paddle: { y: 50, h: 20 }, interceptY: 44.9 }))).toBe('up');
    expect(expectedMove(state({ paddle: { y: 80, h: 20 }, interceptY: 10 }))).toBe('up');
  });

  it('moves down when the intercept is below the paddle centre (larger y)', () => {
    expect(expectedMove(state({ paddle: { y: 50, h: 20 }, interceptY: 55.1 }))).toBe('down');
    expect(expectedMove(state({ paddle: { y: 30, h: 20 }, interceptY: 66 }))).toBe('down');
  });

  it('uses the documented tolerance', () => {
    expect(STAY_TOLERANCE).toBe(5);
  });
});

describe('stateForModel', () => {
  it('sends the DecisionState fields and nothing else', () => {
    const extra = { ...state(), secret: 'do-not-send' } as unknown as DecisionState;
    expect(stateForModel(extra)).toEqual({
      court: { w: 160, h: 100 },
      ball: { x: 80, y: 50, vx: 26.67, vy: 8 },
      paddle: { y: 50, h: 20 },
      interceptY: 50,
      dir: 'toward',
    });
  });

  it('keeps a null intercept as null', () => {
    expect(stateForModel(state({ interceptY: null })).interceptY).toBeNull();
  });

  it('serialises to a small numbers-only payload', () => {
    const json = JSON.stringify(stateForModel(state()));
    expect(json.length).toBeLessThan(200);
    expect(json).not.toMatch(/[A-Za-z]{3,}\s[A-Za-z]{3,}/);
  });
});

describe('shared instructions', () => {
  it('gives the LLM lanes the same instruction text Jev gets', () => {
    expect(LLM_SYSTEM_PROMPT.startsWith(DECISION_INSTRUCTIONS)).toBe(true);
  });

  it('gives the LLM lanes the same criteria Jev gets', () => {
    for (const move of MOVES) {
      expect(LLM_SYSTEM_PROMPT).toContain(`- ${move}: ${MOVE_CRITERIA[move]}`);
    }
  });

  it('describes every legal move exactly once', () => {
    expect(Object.keys(MOVE_CRITERIA).sort()).toEqual([...MOVES].sort());
  });
});

describe('isMove', () => {
  it('accepts the three legal moves', () => {
    for (const move of MOVES) expect(isMove(move)).toBe(true);
  });

  it('rejects anything else', () => {
    for (const value of ['UP', 'left', '', null, undefined, 3, {}]) {
      expect(isMove(value)).toBe(false);
    }
  });
});

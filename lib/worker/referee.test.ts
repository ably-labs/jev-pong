/**
 * The referee is pure, so every test here states the times it cares about
 * rather than waiting for them. No fake timers needed: `tick(now)` IS the clock.
 */
import { describe, expect, it } from 'vitest';
import { POINTS_TO_WIN } from '../game/types';
import {
  DEADLINE_MARGIN_MS,
  EMPTY_DEMO_MS,
  IDLE_MS,
  NO_PLAYER_MS,
  PLAYER_GRACE_MS,
  REQUIRED_PLAYERS,
  createReferee,
  type GameMode,
  type Referee,
} from './referee';

const T0 = 1_000_000;

function referee(mode: GameMode, deadline?: number): Referee {
  return createReferee({ mode, startedAt: T0, deadline: deadline ?? null });
}

/** A vs-jev game with its player in place and one spectator watching. */
function live(): Referee {
  const ref = referee('vs-jev');
  ref.playerEnter('player-1');
  ref.spectatorCount(1);
  ref.tick(T0);
  return ref;
}

describe('createReferee', () => {
  it('keeps playing while nothing has gone wrong', () => {
    expect(live().tick(T0 + 1000)).toEqual({ end: false });
  });

  it('knows how many humans each mode needs', () => {
    expect(REQUIRED_PLAYERS).toEqual({ 'vs-jev': 1, 'vs-human': 2, demo: 0 });
  });
});

describe('won', () => {
  it.each([
    ['the left player', [POINTS_TO_WIN, 1] as const],
    ['the right player', [2, POINTS_TO_WIN] as const],
  ])('ends when %s reaches POINTS_TO_WIN', (_label, [left, right]) => {
    const ref = live();
    ref.score(left, right);
    expect(ref.tick(T0 + 1000)).toEqual({ end: true, reason: 'won' });
  });

  it('does not end one point short', () => {
    const ref = live();
    ref.score(POINTS_TO_WIN - 1, POINTS_TO_WIN - 1);
    expect(ref.tick(T0 + 1000)).toEqual({ end: false });
  });

  it('beats every other reason', () => {
    const ref = referee('vs-jev', T0 + 1000);
    ref.score(POINTS_TO_WIN, 0);
    expect(ref.tick(T0 + NO_PLAYER_MS + IDLE_MS)).toEqual({ end: true, reason: 'won' });
  });
});

describe('player_left', () => {
  it('gives a leaving player the grace window before forfeiting', () => {
    const ref = live();
    ref.playerLeave('player-1');

    expect(ref.tick(T0 + 1)).toEqual({ end: false });
    expect(ref.tick(T0 + 1 + PLAYER_GRACE_MS)).toEqual({ end: false });
    expect(ref.tick(T0 + 2 + PLAYER_GRACE_MS)).toEqual({ end: true, reason: 'player_left' });
  });

  it('forgives a player who comes back inside the grace window', () => {
    const ref = live();
    ref.playerLeave('player-1');
    ref.tick(T0 + 1000);

    ref.playerEnter('player-1-again');
    expect(ref.tick(T0 + 2000)).toEqual({ end: false });
    expect(ref.state.absentSince).toBeNull();
    expect(ref.tick(T0 + 2000 + PLAYER_GRACE_MS + 1)).toEqual({ end: false });
  });

  it('counts a vs-human game as short-handed when one of the two leaves', () => {
    const ref = referee('vs-human');
    ref.playerEnter('a');
    ref.playerEnter('b');
    ref.spectatorCount(1);
    ref.tick(T0);

    ref.playerLeave('b');
    expect(ref.tick(T0 + 1)).toEqual({ end: false });
    expect(ref.tick(T0 + 2 + PLAYER_GRACE_MS)).toEqual({ end: true, reason: 'player_left' });
  });

  it('never fires in demo, which needs nobody', () => {
    const ref = referee('demo');
    ref.spectatorCount(1);
    expect(ref.tick(T0 + PLAYER_GRACE_MS * 10)).toEqual({ end: false });
  });
});

describe('no_player', () => {
  it('gives up when nobody ever takes a side', () => {
    const ref = referee('vs-jev');
    ref.spectatorCount(1);

    expect(ref.tick(T0 + NO_PLAYER_MS)).toEqual({ end: false });
    expect(ref.tick(T0 + NO_PLAYER_MS + 1)).toEqual({ end: true, reason: 'no_player' });
  });

  it('waits for BOTH humans in vs-human', () => {
    const ref = referee('vs-human');
    ref.playerEnter('a');
    ref.spectatorCount(1);
    expect(ref.tick(T0 + NO_PLAYER_MS + 1)).toEqual({ end: true, reason: 'no_player' });
  });

  it('stops applying once the players have arrived', () => {
    const ref = live();
    expect(ref.tick(T0 + NO_PLAYER_MS + 1)).toEqual({ end: false });
  });

  it('never fires in demo', () => {
    const ref = referee('demo');
    ref.spectatorCount(1);
    expect(ref.tick(T0 + NO_PLAYER_MS + 1)).toEqual({ end: false });
  });
});

describe('idle', () => {
  it('ends a player game with no input and nobody watching', () => {
    const ref = referee('vs-jev');
    ref.playerEnter('player-1');
    ref.tick(T0);

    expect(ref.tick(T0 + IDLE_MS)).toEqual({ end: false });
    expect(ref.tick(T0 + IDLE_MS + 1)).toEqual({ end: true, reason: 'idle' });
  });

  it('is reset by a player input', () => {
    const ref = referee('vs-jev');
    ref.playerEnter('player-1');
    ref.tick(T0);
    ref.tick(T0 + IDLE_MS - 1000);

    ref.input('player-1');
    const at = T0 + IDLE_MS - 500;
    expect(ref.tick(at)).toEqual({ end: false });
    expect(ref.tick(at + IDLE_MS)).toEqual({ end: false });
    expect(ref.tick(at + IDLE_MS + 1)).toEqual({ end: true, reason: 'idle' });
  });

  it('is held off while anyone is watching', () => {
    const ref = live();
    expect(ref.tick(T0 + IDLE_MS * 5)).toEqual({ end: false });
  });

  it('runs a never-watched demo for the longer window', () => {
    const ref = referee('demo');
    expect(ref.tick(T0 + IDLE_MS + 1)).toEqual({ end: false });
    expect(ref.tick(T0 + EMPTY_DEMO_MS)).toEqual({ end: false });
    expect(ref.tick(T0 + EMPTY_DEMO_MS + 1)).toEqual({ end: true, reason: 'idle' });
  });

  it('drops a demo to the short window once it has been watched', () => {
    const ref = referee('demo');
    ref.spectatorCount(2);
    const leftAt = T0 + 30_000;
    ref.tick(leftAt);
    ref.spectatorCount(0);

    expect(ref.tick(leftAt + IDLE_MS)).toEqual({ end: false });
    expect(ref.tick(leftAt + IDLE_MS + 1)).toEqual({ end: true, reason: 'idle' });
  });
});

describe('time_limit', () => {
  it('ends one margin before the invocation deadline', () => {
    const deadline = T0 + 300_000;
    const ref = referee('vs-jev', deadline);
    ref.playerEnter('player-1');
    ref.spectatorCount(1);

    expect(ref.tick(deadline - DEADLINE_MARGIN_MS - 1)).toEqual({ end: false });
    expect(ref.tick(deadline - DEADLINE_MARGIN_MS)).toEqual({ end: true, reason: 'time_limit' });
  });

  it('ignores a deadline that was never set', () => {
    const ref = live();
    expect(ref.tick(T0 + 10_000_000)).toEqual({ end: false });
  });

  it('accepts a deadline supplied after the fact', () => {
    const ref = live();
    ref.deadline(T0 + 20_000);
    expect(ref.tick(T0 + 4_000)).toEqual({ end: false });
    expect(ref.tick(T0 + 5_000)).toEqual({ end: true, reason: 'time_limit' });
  });
});

describe('latching', () => {
  it('keeps returning the first reason it reached', () => {
    const ref = live();
    ref.playerLeave('player-1');
    // The absence is noticed at the next tick; the grace runs from there.
    ref.tick(T0 + 1);
    expect(ref.tick(T0 + PLAYER_GRACE_MS + 2)).toEqual({ end: true, reason: 'player_left' });

    ref.score(POINTS_TO_WIN, 0);
    expect(ref.tick(T0 + PLAYER_GRACE_MS + 3)).toEqual({ end: true, reason: 'player_left' });
    expect(ref.state.ended).toBe('player_left');
  });
});

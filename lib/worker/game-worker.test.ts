/**
 * The worker, driven against an in-memory Ably (./fake-ably) and a fake clock.
 *
 * Everything else is real — engine, referee, coalescing, shutdown — so these
 * tests are about behaviour on the wire: what a browser would actually see.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CENTRE_Y } from '../game/engine';
import { createMockDecider } from '../game/mock-decider';
import { INPUT_MESSAGE } from '../ably/presence';
import {
  CHANNELS,
  HEARTBEAT_MS,
  INPUT_TTL_MS,
  PLAY_MIN_STEP_MS,
  POINTS_TO_WIN,
  POINT_SERVE_DELAY_MS,
  SERVE_DELAY_MS,
  type DecideResponse,
  type Decider,
  type Move,
  type Snapshot,
} from '../game/types';
import { FakeAbly, type FakeChannel } from './fake-ably';
import {
  MAX_CONSECUTIVE_FAILURES,
  PADDLE_TICK_MS,
  PADDLE_TICK_UNITS,
  STATE_COALESCE_MS,
  STATE_MESSAGE,
  runGameWorker,
  type GameSummary,
  type GameWorkerOptions,
  type WorkerEndReason,
} from './game-worker';
import type { GameMode } from './referee';

const GAME_ID = 'ab23cd45';
const KEY = 'app.key:secret';

/** A decider that takes `latencyMs` of fake time and then answers `move`. */
function fixedDecider(move: Move, latencyMs: number): Decider {
  return {
    async decide(): Promise<DecideResponse> {
      await new Promise((resolve) => setTimeout(resolve, latencyMs));
      return { ok: true, move, latencyMs, model: 'mock' };
    },
  };
}

/** A decider that fails the way a spent Gateway budget does. */
function failingDecider(error: 'out_of_credits' | 'model_error'): Decider {
  return {
    async decide(): Promise<DecideResponse> {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { ok: false, error, message: 'no credits left' };
    },
  };
}

/** Fails whenever `failsOn(call)` says so, counting calls from 1. */
function flakyDecider(
  failsOn: (call: number) => boolean,
  error: 'model_error' | 'rate_limited' = 'model_error',
): Decider & { calls: number } {
  const decider = {
    calls: 0,
    async decide(): Promise<DecideResponse> {
      await new Promise((resolve) => setTimeout(resolve, 10));
      decider.calls += 1;
      if (failsOn(decider.calls)) {
        return { ok: false, error, message: 'gateway 502 upstream unavailable' };
      }
      return { ok: true, move: 'stay', latencyMs: 10, model: 'mock' };
    },
  };
  return decider;
}

/** A decider that throws rather than returning a typed failure. */
function throwingDecider(): Decider {
  return {
    async decide(): Promise<DecideResponse> {
      await new Promise((resolve) => setTimeout(resolve, 10));
      throw new Error('socket hang up');
    },
  };
}

/**
 * Perfect play, and slow enough that it never answers inside a test — the ball
 * stays put so nothing but the rule under test can end the game.
 */
function stalledDecider(): Decider {
  return createMockDecider({ latencyMs: 600_000 });
}

interface Harness {
  client: FakeAbly;
  game: FakeChannel;
  lobby: FakeChannel;
  done: Promise<GameSummary>;
  states(): Snapshot[];
  last(): Snapshot;
}

function start(
  options: Partial<GameWorkerOptions> & { mode: GameMode; seedMembers?: Array<{ clientId: string; data: unknown }> },
): Harness {
  let client: FakeAbly | null = null;
  const { seedMembers = [], ...rest } = options;

  const done = runGameWorker({
    gameId: GAME_ID,
    seed: 42,
    ablyKey: KEY,
    decider: stalledDecider(),
    ...rest,
    createClient: (clientOptions) => {
      client = new FakeAbly(clientOptions);
      for (const member of seedMembers) {
        client.channel(CHANNELS.game(GAME_ID)).members.push({ ...member, action: 'present' });
      }
      return client;
    },
  });

  if (client === null) throw new Error('the worker did not build its client synchronously');
  const ably: FakeAbly = client;
  const game = ably.channel(CHANNELS.game(GAME_ID));
  const lobby = ably.channel(CHANNELS.lobby);

  return {
    client: ably,
    game,
    lobby,
    done,
    states: () => game.messages(STATE_MESSAGE).map((entry) => entry.data as Snapshot),
    last: () => {
      const all = game.messages(STATE_MESSAGE);
      return all[all.length - 1].data as Snapshot;
    },
  };
}

/** Let the worker finish its setup (attach, subscribe, enter, presence.get). */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

/** The whole shutdown contract, asserted in one place. */
function expectClosedDown(harness: Harness, reason: WorkerEndReason): void {
  const final = harness.last();
  expect(final.status).toBe('over');
  // The reason always leads; 'error' appends a short, safe detail after it.
  expect(final.message).toMatch(new RegExp(`^${reason}(: |$)`));
  expect((final.message ?? '').length).toBeLessThanOrEqual(120);

  const gameLeave = harness.game.presenceCalls.filter((call) => call.action === 'leave');
  const lobbyLeave = harness.lobby.presenceCalls.filter((call) => call.action === 'leave');
  expect(gameLeave).toHaveLength(1);
  expect(gameLeave[0].data).toMatchObject({ role: 'agent' });
  expect(lobbyLeave).toHaveLength(1);
  expect(lobbyLeave[0].data).toMatchObject({ gameId: GAME_ID, status: 'over' });

  expect(harness.game.detachCount).toBe(1);
  expect(harness.lobby.detachCount).toBe(1);
  expect(harness.client.closeCount).toBe(1);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('joining the channel', () => {
  it('enters the game presence set as the agent and the lobby as a live game', async () => {
    const harness = start({ mode: 'demo', model: 'jev', deadline: new Date(Date.now() + 16_000) });
    await settle();

    expect(harness.client.options.clientId).toBe(`agent:jev:${GAME_ID}`);
    expect(harness.client.options.echoMessages).toBe(false);
    expect(harness.game.attachCount).toBe(1);

    const [entered] = harness.game.presenceCalls;
    expect(entered.action).toBe('enter');
    expect(entered.data).toEqual({ role: 'agent', model: 'jev', side: 'right' });

    const [lobbyEntered] = harness.lobby.presenceCalls;
    expect(lobbyEntered.action).toBe('enter');
    expect(lobbyEntered.data).toMatchObject({
      gameId: GAME_ID,
      model: 'jev',
      score: [0, 0],
      status: 'serving',
      viewers: 0,
    });
    expect((lobbyEntered.data as { startedAt: number }).startedAt).toBeTypeOf('number');

    await vi.advanceTimersByTimeAsync(2_000);
    await harness.done;
  });

  it('enters vs-human as a referee with no model', async () => {
    const harness = start({
      mode: 'vs-human',
      deadline: new Date(Date.now() + 16_000),
      seedMembers: [
        { clientId: 'a', data: { role: 'player' } },
        { clientId: 'b', data: { role: 'player' } },
      ],
    });
    await settle();

    expect(harness.game.presenceCalls[0].data).toEqual({ role: 'agent', model: null });
    expect(harness.lobby.presenceCalls[0].data).toMatchObject({ model: 'human' });

    await vi.advanceTimersByTimeAsync(2_000);
    await harness.done;
  });

  it('publishes a serving state while it waits for a player', async () => {
    const harness = start({ mode: 'vs-jev' });
    await settle();

    const states = harness.states();
    expect(states).toHaveLength(1);
    expect(states[0].status).toBe('serving');
    expect(states[0].tick).toBe(0);

    await vi.advanceTimersByTimeAsync(10_000);
    // Still waiting: nothing has moved.
    expect(harness.states().every((state) => state.tick === 0)).toBe(true);

    await vi.advanceTimersByTimeAsync(51_000);
    const summary = await harness.done;
    expect(summary.reason).toBe('no_player');
  });

  it('counts down before the first serve, then serves', async () => {
    // The ball no longer moves the instant a player arrives: SERVE_DELAY_MS of
    // 'serving' frames give them time to find the court first.
    const harness = start({
      mode: 'vs-jev',
      deadline: new Date(Date.now() + 25_000),
      seedMembers: [{ clientId: 'p1', data: { role: 'player' } }],
    });
    await settle();

    await vi.advanceTimersByTimeAsync(SERVE_DELAY_MS - PADDLE_TICK_MS);
    expect(harness.states().every((state) => state.status === 'serving')).toBe(true);
    // And they are frames, not one frozen one: the client can show a countdown.
    expect(harness.states().length).toBeGreaterThan(SERVE_DELAY_MS / PADDLE_TICK_MS - 4);

    await vi.advanceTimersByTimeAsync(PADDLE_TICK_MS * 2);
    expect(harness.states().map((state) => state.status)).toContain('playing');

    await vi.advanceTimersByTimeAsync(8_000);
    await harness.done;
  });
});

describe('the ball', () => {
  it('steps exactly once per model decision', async () => {
    const harness = start({
      mode: 'demo',
      decider: fixedDecider('stay', 100),
      deadline: new Date(Date.now() + 16_000),
    });
    await settle();
    await vi.advanceTimersByTimeAsync(1_000);
    const summary = await harness.done;

    const ballFrames = harness.states().filter((state) => state.move !== null);
    expect(ballFrames.length).toBeGreaterThanOrEqual(8);
    ballFrames.forEach((state, index) => {
      expect(state.tick).toBe(index + 1);
      expect(state.latencyMs).toBe(100);
    });
    expect(summary.ticks).toBe(ballFrames.length);
  });

  it('runs on a fixed interval when there is no model in the game', async () => {
    const harness = start({
      mode: 'vs-human',
      deadline: new Date(Date.now() + 25_000),
      seedMembers: [
        { clientId: 'a', data: { role: 'player' } },
        { clientId: 'b', data: { role: 'player' } },
      ],
    });
    await settle();
    // vs-human is a mode humans play, so it gets the serve countdown too.
    await vi.advanceTimersByTimeAsync(SERVE_DELAY_MS + 900);

    const ticks = harness.states().map((state) => state.tick);
    expect(Math.max(...ticks)).toBeGreaterThanOrEqual(5);

    await vi.advanceTimersByTimeAsync(8_000);
    await harness.done;
  });
});

describe('human input', () => {
  it('moves that player paddle at the human speed, one tick of travel at a time', async () => {
    // A paddle now moves HUMAN_PADDLE_SPEED x the tick length, not a whole
    // model step: 8 units per 100ms rather than a 12-unit jump.
    const harness = start({
      mode: 'vs-jev',
      deadline: new Date(Date.now() + 16_000),
      seedMembers: [{ clientId: 'p1', data: { role: 'player' } }],
    });
    await settle();
    expect(harness.last().leftY).toBe(CENTRE_Y);

    harness.game.emitMessage(INPUT_MESSAGE, 'p1', { move: 'up' });
    await vi.advanceTimersByTimeAsync(PADDLE_TICK_MS);
    expect(harness.last().leftY).toBe(CENTRE_Y - PADDLE_TICK_UNITS);

    // Sticky, within the TTL: the same input keeps being applied.
    await vi.advanceTimersByTimeAsync(PADDLE_TICK_MS);
    expect(harness.last().leftY).toBe(CENTRE_Y - 2 * PADDLE_TICK_UNITS);

    harness.game.emitMessage(INPUT_MESSAGE, 'p1', { move: 'stay' });
    const held = harness.last().leftY;
    await vi.advanceTimersByTimeAsync(PADDLE_TICK_MS * 3);
    expect(harness.last().leftY).toBe(held);

    await vi.advanceTimersByTimeAsync(2_000);
    await harness.done;
  });

  it('expires a held input after INPUT_TTL_MS', async () => {
    // A dropped 'stay' used to pin the paddle against the top of the court for
    // the rest of the game, because the worker kept applying the last thing it
    // heard. An input is now only good for INPUT_TTL_MS.
    const harness = start({
      mode: 'vs-jev',
      deadline: new Date(Date.now() + 25_000),
      seedMembers: [{ clientId: 'p1', data: { role: 'player' } }],
    });
    await settle();

    harness.game.emitMessage(INPUT_MESSAGE, 'p1', { move: 'up' });
    await vi.advanceTimersByTimeAsync(INPUT_TTL_MS);
    const travelled = CENTRE_Y - harness.last().leftY;
    expect(travelled).toBeCloseTo((INPUT_TTL_MS / PADDLE_TICK_MS) * PADDLE_TICK_UNITS, 6);

    // Nothing more arrives: the paddle stops where it is.
    await vi.advanceTimersByTimeAsync(PADDLE_TICK_MS * 10);
    expect(CENTRE_Y - harness.last().leftY).toBeCloseTo(travelled, 6);

    // A fresh input starts it moving again.
    harness.game.emitMessage(INPUT_MESSAGE, 'p1', { move: 'up' });
    await vi.advanceTimersByTimeAsync(PADDLE_TICK_MS);
    expect(CENTRE_Y - harness.last().leftY).toBeCloseTo(travelled + PADDLE_TICK_UNITS, 6);

    await vi.advanceTimersByTimeAsync(10_000);
    await harness.done;
  });

  it('ignores input from anyone who is not a seated player', async () => {
    const harness = start({
      mode: 'vs-jev',
      deadline: new Date(Date.now() + 16_000),
      seedMembers: [{ clientId: 'p1', data: { role: 'player' } }],
    });
    await settle();

    harness.game.emitMessage(INPUT_MESSAGE, 'watcher', { move: 'up' });
    harness.game.emitMessage(INPUT_MESSAGE, 'p1', { move: 'sideways' });
    await vi.advanceTimersByTimeAsync(PADDLE_TICK_MS * 3);
    expect(harness.last().leftY).toBe(CENTRE_Y);

    await vi.advanceTimersByTimeAsync(2_000);
    await harness.done;
  });

  it('seats the second arrival on the right in vs-human', async () => {
    const harness = start({
      mode: 'vs-human',
      deadline: new Date(Date.now() + 16_000),
      seedMembers: [
        { clientId: 'a', data: { role: 'player' } },
        { clientId: 'b', data: { role: 'player' } },
      ],
    });
    await settle();

    harness.game.emitMessage(INPUT_MESSAGE, 'a', { move: 'up' });
    harness.game.emitMessage(INPUT_MESSAGE, 'b', { move: 'down' });
    await vi.advanceTimersByTimeAsync(PADDLE_TICK_MS);

    expect(harness.last().leftY).toBe(CENTRE_Y - PADDLE_TICK_UNITS);
    expect(harness.last().rightY).toBe(CENTRE_Y + PADDLE_TICK_UNITS);

    await vi.advanceTimersByTimeAsync(2_000);
    await harness.done;
  });
});

describe('pacing a game a human is playing', () => {
  /** Ball frames only, with the wire time each went out at. */
  function ballFrames(harness: Harness): Array<{ at: number; state: Snapshot }> {
    return harness.game
      .messages(STATE_MESSAGE)
      .map((entry) => ({ at: entry.at, state: entry.data as Snapshot }))
      .filter((entry) => entry.state.move !== null);
  }

  it('never completes a ball step faster than PLAY_MIN_STEP_MS', async () => {
    // Jev answers in ~200ms. Unpaced, that is a court crossing in 1.6s, which
    // is not a game. The floor holds the step; the number still says 60ms.
    const harness = start({
      mode: 'vs-jev',
      decider: fixedDecider('stay', 60),
      deadline: new Date(Date.now() + 40_000),
      seedMembers: [{ clientId: 'p1', data: { role: 'player' } }],
    });
    await settle();
    await vi.advanceTimersByTimeAsync(SERVE_DELAY_MS + 4_000);

    const frames = ballFrames(harness);
    expect(frames.length).toBeGreaterThan(3);
    for (let i = 1; i < frames.length; i += 1) {
      expect(frames[i].at - frames[i - 1].at).toBeGreaterThanOrEqual(PLAY_MIN_STEP_MS);
    }
    // The published latency is the model's real answer time, never the floor.
    for (const frame of frames) expect(frame.state.latencyMs).toBe(60);

    await vi.advanceTimersByTimeAsync(25_000);
    await harness.done;
  });

  it('leaves demo unpaced', async () => {
    const harness = start({
      mode: 'demo',
      decider: fixedDecider('stay', 60),
      deadline: new Date(Date.now() + 18_000),
    });
    await settle();
    await vi.advanceTimersByTimeAsync(1_000);

    const frames = ballFrames(harness);
    const gaps = frames.slice(1).map((frame, i) => frame.at - frames[i].at);
    expect(gaps.length).toBeGreaterThan(3);
    expect(Math.min(...gaps)).toBeLessThan(PLAY_MIN_STEP_MS);

    await vi.advanceTimersByTimeAsync(3_000);
    await harness.done;
  });

  it('holds a serve countdown after a point, then serves itself', async () => {
    // The model paddle drives itself into the top of the court, so it concedes.
    const harness = start({
      mode: 'vs-jev',
      decider: fixedDecider('up', 10),
      deadline: new Date(Date.now() + 60_000),
      seedMembers: [{ clientId: 'p1', data: { role: 'player' } }],
    });
    await settle();
    await vi.advanceTimersByTimeAsync(SERVE_DELAY_MS + 30_000);

    const frames = ballFrames(harness);
    const conceded = frames.findIndex((frame) => frame.state.score[0] + frame.state.score[1] > 0);
    expect(conceded).toBeGreaterThan(0);
    expect(frames[conceded + 1]).toBeDefined();
    // The next ball frame is a whole countdown away, not one decision away.
    expect(frames[conceded + 1].at - frames[conceded].at).toBeGreaterThanOrEqual(
      POINT_SERVE_DELAY_MS,
    );

    // And the wait is shown as 'serving', not as a frozen 'point'.
    const between = harness.game
      .messages(STATE_MESSAGE)
      .filter((entry) => entry.at > frames[conceded].at && entry.at < frames[conceded + 1].at)
      .map((entry) => (entry.data as Snapshot).status);
    expect(between).toContain('serving');

    await vi.advanceTimersByTimeAsync(40_000);
    await harness.done;
  });
});

describe('when nothing is happening', () => {
  it('publishes a frame at least every HEARTBEAT_MS', async () => {
    // Silence used to mean two different things — a model still thinking, and
    // a player standing still — so a stalled game looked like a slow one.
    const harness = start({
      mode: 'vs-jev',
      decider: stalledDecider(),
      deadline: new Date(Date.now() + 25_000),
      seedMembers: [{ clientId: 'p1', data: { role: 'player' } }],
    });
    await settle();
    await vi.advanceTimersByTimeAsync(SERVE_DELAY_MS + 5_000);

    const frames = harness.game.messages(STATE_MESSAGE);
    expect(frames.length).toBeGreaterThan(5);
    for (let i = 1; i < frames.length; i += 1) {
      expect(frames[i].at - frames[i - 1].at).toBeLessThanOrEqual(HEARTBEAT_MS + PADDLE_TICK_MS);
    }

    await vi.advanceTimersByTimeAsync(10_000);
    await harness.done;
  });

  it('logs one line per decision and one per point', async () => {
    const lines: string[] = [];
    const harness = start({
      mode: 'demo',
      decider: fixedDecider('up', 40),
      deadline: new Date(Date.now() + 18_000),
      log: (message) => lines.push(message),
    });
    await settle();
    await vi.advanceTimersByTimeAsync(3_000);
    await harness.done;

    const decisions = lines.filter((line) => line.startsWith('decision '));
    expect(decisions.length).toBeGreaterThan(5);
    expect(decisions[0]).toBe('decision tick=1 model=jev latency=40ms move=up');
    for (const line of decisions) {
      expect(line).toMatch(/^decision tick=\d+ model=\w+ latency=\d+ms move=(up|down|stay)$/);
    }
    // The model paddle drives into the top of the court, so the wall scores.
    const points = lines.filter((line) => line.startsWith('point '));
    expect(points.length).toBeGreaterThan(0);
    expect(points[0]).toMatch(/^point (left|right) \d+-\d+ tick=\d+$/);
  });
});

describe('publishing rate', () => {
  it('holds paddle-only frames to at most one per coalescing interval', async () => {
    const harness = start({
      mode: 'vs-jev',
      decider: fixedDecider('up', 130),
      deadline: new Date(Date.now() + 18_000),
      seedMembers: [{ clientId: 'p1', data: { role: 'player' } }],
    });
    await settle();
    harness.game.emitMessage(INPUT_MESSAGE, 'p1', { move: 'down' });

    await vi.advanceTimersByTimeAsync(3_000);
    await harness.done;

    const frames = harness.game.messages(STATE_MESSAGE);
    let checked = 0;
    for (let i = 1; i < frames.length; i += 1) {
      const previous = frames[i - 1].data as Snapshot;
      const current = frames[i].data as Snapshot;
      // Ball frames and status changes are urgent by design; everything else
      // is a paddle frame and must respect the interval.
      if (current.move !== null || current.status !== previous.status) continue;
      expect(frames[i].at - frames[i - 1].at).toBeGreaterThanOrEqual(STATE_COALESCE_MS);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('updates lobby presence for score and viewers, at most once a second', async () => {
    const harness = start({
      mode: 'demo',
      decider: fixedDecider('stay', 60),
      deadline: new Date(Date.now() + 19_000),
    });
    await settle();

    harness.game.emitPresence('enter', 'watcher-1', { role: 'spectator' });
    await vi.advanceTimersByTimeAsync(3_500);
    await harness.done;

    const updates = harness.lobby.presenceCalls.filter((call) => call.action === 'update');
    expect(updates.length).toBeGreaterThan(0);
    expect(updates.some((call) => (call.data as { viewers: number }).viewers === 1)).toBe(true);

    const scored = updates.filter((call) => {
      const data = call.data as { score: [number, number] };
      return data.score[0] > 0 || data.score[1] > 0;
    });
    expect(scored.length).toBeGreaterThan(0);

    for (let i = 1; i < updates.length; i += 1) {
      const sameStatus =
        (updates[i].data as { status: string }).status ===
        (updates[i - 1].data as { status: string }).status;
      if (!sameStatus) continue;
      expect(updates[i].at - updates[i - 1].at).toBeGreaterThanOrEqual(1_000);
    }
  });
});

describe('ending', () => {
  it('ends with "won" when a score reaches the target', async () => {
    const harness = start({ mode: 'demo', decider: fixedDecider('stay', 10) });
    await settle();
    await vi.advanceTimersByTimeAsync(20_000);
    const summary = await harness.done;

    expect(summary.reason).toBe('won');
    expect(Math.max(...summary.score)).toBe(POINTS_TO_WIN);
    expectClosedDown(harness, 'won');
  });

  it('ends with "player_left" after the grace window', async () => {
    const harness = start({
      mode: 'vs-jev',
      seedMembers: [{ clientId: 'p1', data: { role: 'player' } }],
    });
    await settle();

    harness.game.emitPresence('leave', 'p1', { role: 'player' });
    await vi.advanceTimersByTimeAsync(14_000);
    expect(harness.last().status).not.toBe('over');

    await vi.advanceTimersByTimeAsync(2_000);
    const summary = await harness.done;
    expect(summary.reason).toBe('player_left');
    expectClosedDown(harness, 'player_left');
  });

  it('ends with "no_player" when nobody takes a side', async () => {
    const harness = start({ mode: 'vs-jev' });
    await settle();
    await vi.advanceTimersByTimeAsync(61_000);

    const summary = await harness.done;
    expect(summary.reason).toBe('no_player');
    expectClosedDown(harness, 'no_player');
  });

  it('ends with "time_limit" before the invocation deadline', async () => {
    const harness = start({ mode: 'demo', deadline: new Date(Date.now() + 20_000) });
    await settle();
    await vi.advanceTimersByTimeAsync(4_900);
    expect(harness.last().status).not.toBe('over');

    await vi.advanceTimersByTimeAsync(200);
    const summary = await harness.done;
    expect(summary.reason).toBe('time_limit');
    expectClosedDown(harness, 'time_limit');
  });

  it('ends with "idle" when a demo nobody watched has run long enough', async () => {
    const harness = start({ mode: 'demo' });
    await settle();
    await vi.advanceTimersByTimeAsync(301_000);

    const summary = await harness.done;
    expect(summary.reason).toBe('idle');
    expectClosedDown(harness, 'idle');
  });

  it('ends with "error" and a credits status when the model has no budget', async () => {
    const harness = start({ mode: 'demo', decider: failingDecider('out_of_credits') });
    await settle();
    await vi.advanceTimersByTimeAsync(100);

    const summary = await harness.done;
    expect(summary.reason).toBe('error');

    const states = harness.states();
    const failure = states[states.length - 2];
    expect(failure.status).toBe('credits');
    expect(failure.message).toBe('no credits left');
    expect(harness.last().message).toBe('error: out_of_credits no credits left');
    expectClosedDown(harness, 'error');
  });

  it('publishes nothing at all once it has ended', async () => {
    const harness = start({ mode: 'demo', deadline: new Date(Date.now() + 16_000) });
    await settle();
    await vi.advanceTimersByTimeAsync(1_100);
    await harness.done;

    const after = harness.game.published.length;
    const lobbyAfter = harness.lobby.presenceCalls.length;
    await vi.advanceTimersByTimeAsync(10_000);

    expect(harness.game.published).toHaveLength(after);
    expect(harness.lobby.presenceCalls).toHaveLength(lobbyAfter);
    expect(harness.client.closeCount).toBe(1);
  });
});

describe('waiting for players', () => {
  it('lets a seated player move while the lane still reads "serving"', async () => {
    const harness = start({
      mode: 'vs-human',
      seedMembers: [{ clientId: 'a', data: { role: 'player' } }],
    });
    await settle();

    harness.game.emitMessage(INPUT_MESSAGE, 'a', { move: 'down' });
    await vi.advanceTimersByTimeAsync(PADDLE_TICK_MS * 2);

    const last = harness.last();
    expect(last.status).toBe('serving');
    expect(last.leftY).toBe(CENTRE_Y + 2 * PADDLE_TICK_UNITS);
    expect(last.tick).toBe(0);
    // The second player never shows up.
    expect(harness.states().every((state) => state.status === 'serving')).toBe(true);

    await vi.advanceTimersByTimeAsync(61_000);
    const summary = await harness.done;
    expect(summary.reason).toBe('no_player');
  });
});

describe('a model that misbehaves', () => {
  it('plays through transient failures and resets the count on success', async () => {
    // Fails twice, answers once, forever: never three in a row.
    const decider = flakyDecider((call) => call % 3 !== 0);
    const harness = start({
      mode: 'demo',
      decider,
      deadline: new Date(Date.now() + 16_000),
    });
    await settle();
    await vi.advanceTimersByTimeAsync(1_000);
    const summary = await harness.done;

    // It survived many runs of two failures, so it ended for an ordinary
    // reason (the game was won, or the deadline came first) — never 'error'.
    expect(['won', 'time_limit']).toContain(summary.reason);
    expect(decider.calls).toBeGreaterThan(MAX_CONSECUTIVE_FAILURES * 3);

    // Every decision still moved the ball exactly one segment, failures included.
    const ballFrames = harness.states().filter((state) => state.move !== null);
    ballFrames.forEach((state, index) => {
      expect(state.tick).toBe(index + 1);
    });
    expect(ballFrames.length).toBe(decider.calls);
    // A failed tick is a missed move, not a broken lane.
    expect(harness.states().some((state) => state.status === 'error')).toBe(false);
  });

  it.each([
    ['model_error', 'model_error' as const],
    ['rate_limited', 'rate_limited' as const],
  ])('gives up after three consecutive %s failures', async (_label, error) => {
    const decider = flakyDecider(() => true, error);
    const harness = start({ mode: 'demo', decider });
    await settle();
    await vi.advanceTimersByTimeAsync(1_000);
    const summary = await harness.done;

    expect(summary.reason).toBe('error');
    expect(decider.calls).toBe(MAX_CONSECUTIVE_FAILURES);

    const states = harness.states();
    const failure = states[states.length - 2];
    expect(failure.status).toBe('error');

    const final = harness.last();
    expect(final.message).toContain(error);
    expect(final.message).toContain('gateway 502');
    expectClosedDown(harness, 'error');
  });

  it('counts a decider that throws as a transient failure', async () => {
    const harness = start({ mode: 'demo', decider: throwingDecider() });
    await settle();
    await vi.advanceTimersByTimeAsync(1_000);
    const summary = await harness.done;

    expect(summary.reason).toBe('error');
    // Three attempts, and two of them still advanced the ball.
    expect(summary.ticks).toBe(MAX_CONSECUTIVE_FAILURES - 1);
    expect(harness.last().message).toContain('socket hang up');
  });

  it('keeps the worker key out of the message it publishes', async () => {
    const harness = start({
      mode: 'demo',
      decider: {
        async decide(): Promise<DecideResponse> {
          await new Promise((resolve) => setTimeout(resolve, 10));
          throw new Error(`auth failed for ${KEY}`);
        },
      },
    });
    await settle();
    await vi.advanceTimersByTimeAsync(1_000);
    await harness.done;

    const final = harness.last();
    expect(final.message).not.toContain(KEY);
    expect(final.message).toContain('[redacted]');
  });
});

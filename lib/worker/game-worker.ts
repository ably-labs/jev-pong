/**
 * Jev Pong — the game worker. The agent is a participant, not a server.
 *
 * One call = one game. The worker opens its own Ably connection, enters the
 * game channel's presence set as `role: 'agent'`, and from there it is just
 * another member of the channel: humans publish `input`, it publishes `state`.
 * There is no private API between the player and the model — everything either
 * side knows travelled over the channel, which is the whole point of the demo.
 *
 * TWO CLOCKS, deliberately:
 *   - The BALL advances once per model decision (`applyTick`). A slow model is
 *     a slow ball. That is the thing the demo exists to show, so nothing is
 *     allowed to advance the ball on a timer in a mode that has a model.
 *   - HUMAN PADDLES move on their own 10Hz tick (`applyPaddleMove`) at
 *     HUMAN_PADDLE_SPEED court units per second, because a paddle that only
 *     moved when the model answered would feel broken. The latest input is
 *     sticky, but only for INPUT_TTL_MS: a player who has gone quiet is a
 *     player standing still, not one holding a key down forever.
 *
 * PLAYABLE, NOT JUST HONEST:
 *   In a mode a human is playing, a ball step never completes faster than
 *   PLAY_MIN_STEP_MS. Jev answering in 200ms crosses the court in 1.6s, which
 *   nobody can play. The published `latencyMs` is always the real measured
 *   model latency — the floor paces the ball, it never touches the number.
 *   Demo mode is unpaced: there is no human to be fair to, and the arena is
 *   there to show raw speed.
 *   A game also does not start the instant a player arrives: SERVE_DELAY_MS of
 *   'serving' frames give them time to read the court, and POINT_SERVE_DELAY_MS
 *   does the same after each point.
 *
 * WHO IS WHO:
 *   vs-jev    first human = left, the model = right.
 *   vs-human  first two humans by arrival = left, right. No model; the worker
 *             is only the referee, and the ball runs on a fixed interval.
 *   demo      left is the engine's scripted wall ('auto'), right is the model.
 *
 * WHEN IT STOPS: see ./referee. This file only executes the verdict — publish a
 * final `state` with status 'over' and `message` set to the reason, leave both
 * presence sets, detach, close the connection. That path is idempotent and
 * clears every timer, so the Vercel invocation can actually exit.
 */

import * as Ably from 'ably';
import { Coalescer, statusChanged } from '../ably/coalesce';
import { STATE_MESSAGE, INPUT_MESSAGE, asGamePresence, asInputMessage } from '../ably/presence';
import type { GamePresence, LobbyPresenceWithViewers } from '../ably/presence';
import { decide } from '../decide';
import { applyPaddleMove, applyTick, createEngine, serve, toDecisionState } from '../game/engine';
import { MAX_CONSECUTIVE_FAILURES } from '../game/runner';
import {
  CHANNELS,
  HEARTBEAT_MS,
  HUMAN_PADDLE_SPEED,
  INPUT_TTL_MS,
  PLAY_MIN_STEP_MS,
  POINT_SERVE_DELAY_MS,
  SERVE_DELAY_MS,
  type DecideMode,
  type DecideResponse,
  type Decider,
  type EngineState,
  type LaneStatus,
  type ModelId,
  type Move,
  type Snapshot,
} from '../game/types';
import type { AblyClientOptions, AblyLike, MessageLike, PresenceMemberLike } from './ably-like';
import { REQUIRED_PLAYERS, createReferee, type EndReason, type GameMode } from './referee';

/** The wire name for a `Snapshot`. Defined with the other wire shapes in lib/ably/presence.ts. */
export { STATE_MESSAGE };

/**
 * Human paddles are advanced at 10Hz, whatever the model is doing — and on the
 * arrival of every input, so a press is measured from the instant it arrived to
 * the instant its 'stay' did, not rounded to the tick.
 */
export const PADDLE_TICK_MS = 100;
/** Court units a held human input moves a paddle over one full paddle tick. */
export const PADDLE_TICK_UNITS = (HUMAN_PADDLE_SPEED * PADDLE_TICK_MS) / 1000;
/** With no model in the game, the ball needs a clock of its own. */
export const HUMAN_BALL_TICK_MS = 150;
/** Paddle-only frames are worth at most 20/s on the wire. */
export const STATE_COALESCE_MS = 50;
/** Lobby presence updates: 1/s, except a status change which goes at once. */
export const LOBBY_COALESCE_MS = 1000;
/*
 * The pacing rules themselves are in the contract (lib/game/types.ts), not
 * here: PLAY_MIN_STEP_MS, SERVE_DELAY_MS, POINT_SERVE_DELAY_MS, INPUT_TTL_MS
 * and HEARTBEAT_MS. The worker is the only thing that owns a clock, but a
 * browser has to know what "get ready" means and how long silence may last.
 */
/**
 * Consecutive failed decisions before a game gives up. One number, defined in
 * lib/game/runner.ts and re-exported here, so the two loops cannot drift apart.
 *
 * A single 502 or a rate limit from the Gateway is a missed move, not a dead
 * game — a live run ended 2-0 on one transient error, which is a worse demo
 * than a paddle that stands still for a tick. Only a model that is failing
 * repeatedly is worth ending for.
 */
export { MAX_CONSECUTIVE_FAILURES };

/** Which sides a human may take, per mode. Everything else is the model or the wall. */
const HUMAN_SIDES: Record<GameMode, ReadonlyArray<'left' | 'right'>> = {
  'vs-jev': ['left'],
  'vs-human': ['left', 'right'],
  demo: [],
};

/** A worker stops for a referee verdict, or because the model call failed. */
export type WorkerEndReason = EndReason | 'error';

/** What the worker enters the GAME channel's presence set as. */
export interface AgentPresence {
  role: 'agent';
  /** Null in vs-human: there is no model in the game, only a referee. */
  model: ModelId | null;
  side?: 'left' | 'right';
}

export interface GameWorkerOptions {
  gameId: string;
  mode: GameMode;
  /** The model that plays the right paddle. Ignored by vs-human. Default 'jev'. */
  model?: ModelId;
  seed?: number;
  /** Invocation deadline. The game ends 15s before it. */
  deadline?: Date;
  ablyKey: string;
  /** Injectable for tests. Defaults to `decide()` against the AI Gateway. */
  decider?: Decider;
  /** Injectable for tests. Defaults to a Node `Ably.Realtime`. */
  createClient?: (options: AblyClientOptions) => AblyLike;
  log?: (message: string) => void;
  /** Every snapshot that goes on the wire, for local observation. */
  onState?: (snapshot: Snapshot) => void;
}

export interface GameSummary {
  reason: WorkerEndReason;
  score: [number, number];
  ticks: number;
  durationMs: number;
}

function defaultCreateClient(options: AblyClientOptions): AblyLike {
  return new Ably.Realtime({
    key: options.key,
    clientId: options.clientId,
    echoMessages: options.echoMessages,
  });
}

/** `decide()` with the mode this game plays under. */
function gatewayDecider(model: ModelId, mode: GameMode): Decider {
  const decideMode: DecideMode = mode === 'vs-jev' ? 'play' : 'demo';
  return {
    decide: (state, signal) => decide({ model, state, mode: decideMode }, { signal }),
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

/**
 * One line, no stack, nothing key-shaped. This text reaches the wire in the
 * final snapshot's `message`, so it is treated as untrusted: the worker's own
 * Ably key is stripped by value, and anything that merely LOOKS like a key or a
 * token is stripped by shape.
 */
export function safeText(text: string, secret = '', max = 200): string {
  let out = text.replace(/\s+/g, ' ').trim();
  if (secret !== '') out = out.split(secret).join('[redacted]');
  out = out.replace(/\b(?:sk|vck|eyJ)[A-Za-z0-9._-]{12,}/g, '[redacted]');
  out = out.replace(/\b[A-Za-z0-9_-]{3,}\.[A-Za-z0-9_-]{3,}:[A-Za-z0-9_+/=-]{8,}/g, '[redacted]');
  if (out === '') return 'no detail';
  return out.length > max ? `${out.slice(0, max - 3)}...` : out;
}

function lobbyEquals(a: LobbyPresenceWithViewers, b: LobbyPresenceWithViewers): boolean {
  return (
    a.status === b.status &&
    a.viewers === b.viewers &&
    a.score[0] === b.score[0] &&
    a.score[1] === b.score[1]
  );
}

/**
 * Run one game to completion. Resolves with the summary once the final state is
 * on the wire, presence is left and the connection is closed.
 */
export async function runGameWorker(opts: GameWorkerOptions): Promise<GameSummary> {
  const {
    gameId,
    mode,
    model = 'jev',
    seed = Date.now() | 0,
    deadline,
    ablyKey,
    createClient = defaultCreateClient,
    log = () => {},
    onState,
  } = opts;

  const hasModel = mode !== 'vs-human';
  /** vs-human has no model, and 'human' is the ModelId the lobby shows for it. */
  const laneModel: ModelId = hasModel ? model : 'human';
  const decider = opts.decider ?? gatewayDecider(model, mode);
  const requiredPlayers = REQUIRED_PLAYERS[mode];
  /**
   * Demo is unpaced — no floor, no countdown, nothing between the points. It is
   * the arena lane: the raw speed of the model is the whole exhibit. Every mode
   * a human plays gets both.
   */
  const played = mode !== 'demo';
  const minStepMs = played ? PLAY_MIN_STEP_MS : 0;
  const serveDelayMs = played ? POINT_SERVE_DELAY_MS : 0;
  const startedAt = Date.now();

  const client = createClient({
    key: ablyKey,
    clientId: `agent:${laneModel}:${gameId}`,
    echoMessages: false,
  });
  const gameChannel = client.channels.get(CHANNELS.game(gameId));
  const lobbyChannel = client.channels.get(CHANNELS.lobby);

  const agentPresence: AgentPresence = hasModel
    ? { role: 'agent', model: laneModel, side: 'right' }
    : { role: 'agent', model: null };

  const referee = createReferee({
    mode,
    startedAt,
    deadline: deadline === undefined ? null : deadline.getTime(),
  });

  let state: EngineState = createEngine(seed, 1);
  /** clientId -> presence data, in arrival order (Map keeps insertion order). */
  const members = new Map<string, GamePresence>();
  /** side -> clientId, and the reverse. A side is held until its player leaves. */
  const sides = new Map<'left' | 'right', string>();
  const sideOf = new Map<string, 'left' | 'right'>();
  /** A player's latest input, and when it landed. It expires after INPUT_TTL_MS. */
  const latestMove = new Map<string, { move: Move; at: number; seq?: number }>();
  /** Per side, the time up to which that human paddle's movement has been applied. */
  const paddleClock = new Map<'left' | 'right', number>();
  /** An input landed since the last frame: the next frame carries its seq. */
  let inputChanged = false;
  let spectators = 0;

  const abort = new AbortController();
  let paddleTimer: ReturnType<typeof setInterval> | null = null;
  let ballTimer: ReturnType<typeof setInterval> | null = null;
  /** Cancels an in-progress pacing wait (serve countdown, play-mode floor). */
  let cancelWait: (() => void) | null = null;
  let ended = false;
  let closed = false;
  /** True until the ball is served. The engine says 'idle'; the wire says 'serving'. */
  let waiting = true;
  /** True during a serve countdown, when every paddle tick publishes a frame. */
  let countingDown = false;
  /** Wire time of the last frame that actually went out, for the heartbeat. */
  let lastFrameAt = 0;
  let endReason: WorkerEndReason = 'idle';
  /** Extra text for the final snapshot, when the reason alone does not explain it. */
  let endDetail: string | null = null;
  /** Reset by every successful decision. */
  let failures = 0;

  /** Everything that reaches a log line or the wire goes through this. */
  const describe = (error: unknown, max?: number): string =>
    safeText(messageOf(error), ablyKey, max);

  let resolveEnded: () => void = () => {};
  const endedPromise = new Promise<void>((resolve) => {
    resolveEnded = resolve;
  });
  let signalReady: (() => void) | null = null;
  const readyPromise = new Promise<void>((resolve) => {
    signalReady = resolve;
  });

  /* ------------------------------------------------------------- publishing */

  function snapshot(over: Partial<Snapshot> = {}): Snapshot {
    // A seated player may move their paddle before the ball is served, and
    // those frames go out too — as 'serving', so a viewer never sees the lane
    // flick back to 'idle' between the court appearing and the first serve.
    // A serve countdown after a point reads 'serving' for the same reason: the
    // engine still says 'point', but on screen the next rally is coming.
    const engineStatus = state.status;
    const status: LaneStatus =
      (waiting && engineStatus === 'idle') || (countingDown && engineStatus === 'point')
        ? 'serving'
        : engineStatus;
    return {
      t: Math.max(0, Date.now() - startedAt),
      tick: state.tick,
      seed: state.seed,
      ball: { ...state.ball },
      leftY: state.leftY,
      rightY: state.rightY,
      score: [state.score[0], state.score[1]],
      model: laneModel,
      latencyMs: null,
      move: null,
      status,
      ...inputSeqs(),
      ...over,
    };
  }

  /** `inputSeq` for the frame: the newest seq applied per seated human side. */
  function inputSeqs(): Pick<Snapshot, 'inputSeq'> {
    let inputSeq: Snapshot['inputSeq'];
    for (const [side, clientId] of sides) {
      const seq = latestMove.get(clientId)?.seq;
      if (seq === undefined) continue;
      inputSeq = { ...inputSeq, [side]: seq };
    }
    return inputSeq === undefined ? {} : { inputSeq };
  }

  const states = new Coalescer<Snapshot>({
    intervalMs: STATE_COALESCE_MS,
    isUrgent: statusChanged,
    emit: (value) => {
      lastFrameAt = Date.now();
      onState?.(value);
      void gameChannel.publish(STATE_MESSAGE, value).catch((error: unknown) => {
        log(`publish state failed: ${describe(error)}`);
      });
    },
  });

  /** Paddle frames: coalesced, so a busy 10Hz paddle cannot outrun 20/s. */
  function publishState(value: Snapshot): void {
    if (closed) return;
    states.push(value);
  }

  /** Ball frames and status changes: on the wire now, superseding anything queued. */
  function publishStateNow(value: Snapshot): void {
    if (closed) return;
    states.push(value);
    states.flush();
  }

  function lobbyData(status?: LaneStatus): LobbyPresenceWithViewers {
    return {
      gameId,
      model: laneModel,
      score: [state.score[0], state.score[1]],
      status: status ?? state.status,
      startedAt,
      viewers: spectators,
    };
  }

  let entered: Promise<unknown> = Promise.resolve();
  let lastLobby: LobbyPresenceWithViewers = lobbyData('serving');

  const lobby = new Coalescer<LobbyPresenceWithViewers>({
    intervalMs: LOBBY_COALESCE_MS,
    isUrgent: statusChanged,
    emit: (value) => {
      entered = entered
        .then(() => lobbyChannel.presence.update(value))
        .catch((error: unknown) => {
          log(`lobby presence.update failed: ${describe(error)}`);
        });
    },
  });

  function lobbyChanged(): void {
    if (closed) return;
    const next = lobbyData();
    if (lobbyEquals(next, lastLobby)) return;
    lastLobby = next;
    lobby.push(next);
  }

  /* ---------------------------------------------------------------- presence */

  function maybeReady(): void {
    if (signalReady !== null && sides.size >= requiredPlayers) {
      const resolve = signalReady;
      signalReady = null;
      resolve();
    }
  }

  /** Recompute sides and spectators from the presence set. Idempotent by design. */
  function reconcile(): void {
    let watching = 0;
    for (const data of members.values()) if (data.role === 'spectator') watching += 1;
    if (watching !== spectators) {
      spectators = watching;
      referee.spectatorCount(watching);
      lobbyChanged();
    }

    for (const [side, clientId] of [...sides]) {
      const data = members.get(clientId);
      if (data !== undefined && data.role === 'player') continue;
      sides.delete(side);
      sideOf.delete(clientId);
      latestMove.delete(clientId);
      referee.playerLeave(clientId);
      log(`player left ${side} (${clientId})`);
    }

    for (const [clientId, data] of members) {
      if (data.role !== 'player' || sideOf.has(clientId)) continue;
      const free = HUMAN_SIDES[mode].find((side) => !sides.has(side));
      if (free === undefined) break;
      sides.set(free, clientId);
      sideOf.set(clientId, free);
      referee.playerEnter(clientId);
      log(`player took ${free} (${clientId})`);
    }

    maybeReady();
  }

  function onPresence(member: PresenceMemberLike): void {
    const clientId = member.clientId;
    if (typeof clientId !== 'string' || clientId === '') return;
    const action = member.action ?? 'present';
    const data = action === 'leave' || action === 'absent' ? null : asGamePresence(member.data);
    if (data === null) members.delete(clientId);
    else members.set(clientId, data);
    reconcile();
  }

  function onInput(message: MessageLike): void {
    const clientId = message.clientId;
    const side = typeof clientId === 'string' ? sideOf.get(clientId) : undefined;
    if (clientId === undefined || side === undefined) return;
    const input = asInputMessage(message.data);
    if (input === null) return;
    const now = Date.now();
    // Apply what was held up to this instant BEFORE replacing it, so a 'stay'
    // stops the paddle where it was when the message landed, not at the tick.
    advancePaddle(side, clientId, now);
    latestMove.set(clientId, { move: input.move, at: now, seq: input.seq });
    inputChanged = true;
    referee.input(clientId);
  }

  /**
   * Move one human paddle for the time that has passed since it was last moved,
   * in the direction its player is holding. Continuous: the distance is
   * HUMAN_PADDLE_SPEED x elapsed, so it does not matter whether the input
   * arrived between ticks or on one. An input holds until it expires, and not
   * one millisecond longer.
   */
  function advancePaddle(side: 'left' | 'right', clientId: string, now: number): void {
    const from = paddleClock.get(side) ?? now;
    paddleClock.set(side, now);
    const input = latestMove.get(clientId);
    if (input === undefined || input.move === 'stay') return;
    const until = Math.min(now, input.at + INPUT_TTL_MS);
    const ms = until - from;
    if (ms <= 0) return;
    state = applyPaddleMove(state, side, input.move, (HUMAN_PADDLE_SPEED * ms) / 1000);
  }

  /*
   * An input is sticky, but not forever: after INPUT_TTL_MS with nothing new it
   * expires to 'stay' (see advancePaddle). A dropped 'stay' — a closed tab, a
   * paused sender, a lost message — used to pin the paddle against the top of
   * the court for the rest of the game, because the worker went on applying
   * the last thing it heard.
   */

  /* -------------------------------------------------------------------- run */

  function finish(reason: WorkerEndReason, detail: string | null = null): void {
    if (ended) return;
    ended = true;
    endReason = reason;
    endDetail = detail;
    log(`ending: ${detail === null ? reason : `${reason}: ${detail}`}`);
    // A game that has ended is not waiting for anything: cut any pacing pause
    // short, or the shutdown would sit behind a serve countdown.
    cancelWait?.();
    resolveEnded();
  }

  /** What a viewer is told the game ended for. Capped, one line, no secrets. */
  function endMessage(): string {
    if (endDetail === null) return endReason;
    return safeText(`${endReason}: ${endDetail}`, ablyKey, 120);
  }

  function check(): void {
    const verdict = referee.tick(Date.now());
    if (verdict.end) finish(verdict.reason);
  }

  function stopTimers(): void {
    if (paddleTimer !== null) clearInterval(paddleTimer);
    if (ballTimer !== null) clearInterval(ballTimer);
    paddleTimer = null;
    ballTimer = null;
    cancelWait?.();
  }

  /**
   * Wait `ms`, unless the game ends first — in which case the timer is cleared
   * and the wait returns at once, so a pacing pause can never hold the Vercel
   * invocation open past its shutdown. Only one pacing wait is ever in flight
   * (a serve countdown and a step floor cannot overlap), so one slot is enough.
   */
  function pause(ms: number): Promise<void> {
    if (ms <= 0 || ended) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        cancelWait = null;
        resolve();
      }, ms);
      cancelWait = () => {
        clearTimeout(timer);
        cancelWait = null;
        resolve();
      };
    });
  }

  function onPaddleTick(): void {
    if (ended) return;
    const now = Date.now();
    const before = state;
    for (const [side, clientId] of sides) advancePaddle(side, clientId, now);
    // A frame goes out when something moved, when an input has landed since the
    // last one (its player is waiting to hear that it was applied), throughout
    // a serve countdown (so the "get ready" is visibly ticking), and otherwise
    // at least every HEARTBEAT_MS. That last one is what makes a stalled
    // decision look different from a player who is simply standing still.
    const moved = state !== before;
    if (moved || inputChanged || countingDown || now - lastFrameAt >= HEARTBEAT_MS) {
      inputChanged = false;
      publishState(snapshot());
    }
    check();
  }

  /**
   * The decision loop, and the only thing that advances the ball in a game with
   * a model in it.
   *
   * Ask, wait however long the model takes, move the paddle, advance the ball
   * exactly one segment, publish. Serial on purpose and on no timer at all, so
   * the ball moves at exactly the speed of the model.
   *
   * `toDecisionState` is the whole of what the model is given — the ~130-byte
   * numeric state; the words that go with it are in lib/decide/prompt.ts. The
   * `latencyMs` published with each snapshot is measured around the decision
   * call alone, so a viewer is reading the model's answer time and not this
   * worker's bookkeeping.
   */
  async function ballLoop(): Promise<void> {
    const leftMove: Move | 'auto' = mode === 'demo' ? 'auto' : 'stay';
    while (!ended) {
      const request = toDecisionState(state, 'right');
      const startedDecisionAt = Date.now();
      let result: DecideResponse;
      try {
        result = await decider.decide(request, abort.signal);
      } catch (error) {
        if (ended) return;
        result = { ok: false, error: 'model_error', message: describe(error, 120) };
      }
      if (ended) return;
      const latencyMs = Math.round(Date.now() - startedDecisionAt);

      let move: Move;
      if (result.ok) {
        move = result.move;
        failures = 0;
      } else {
        const safeMessage = safeText(result.message, ablyKey, 120);
        const detail = `${result.error} ${safeMessage}`;
        log(`decider failed (${result.error}): ${safeMessage}`);

        // A spent budget will not fix itself, so it ends the game at once.
        if (result.error === 'out_of_credits') {
          publishStateNow(snapshot({ latencyMs, status: 'credits', message: safeMessage }));
          finish('error', detail);
          return;
        }

        failures += 1;
        if (failures >= MAX_CONSECUTIVE_FAILURES) {
          publishStateNow(snapshot({ latencyMs, status: 'error', message: safeMessage }));
          finish('error', detail);
          return;
        }

        // Transient: a missed move, not a dead game. The ball still advances
        // one segment — the paddle simply does not move this tick.
        move = 'stay';
      }

      // The floor: in a mode somebody is playing, hold the rest of the step
      // before applying it. The paddle tick keeps running through this, so the
      // human paddle stays live while the ball waits.
      if (minStepMs > 0 && latencyMs < minStepMs) {
        await pause(minStepMs - latencyMs);
        if (ended) return;
      }

      // Humans already moved on their own tick, so the engine's left input is
      // 'stay' — except in demo, where the left paddle IS the engine's wall.
      const before = state;
      state = applyTick(state, move, leftMove);
      publishStateNow(snapshot({ latencyMs, move }));
      log(`decision tick=${state.tick} model=${laneModel} latency=${latencyMs}ms move=${move}`);
      referee.score(state.score[0], state.score[1]);
      lobbyChanged();
      check();

      if (state.score[0] !== before.score[0] || state.score[1] !== before.score[1]) {
        const to = state.score[0] > before.score[0] ? 'left' : 'right';
        log(`point ${to} ${state.score[0]}-${state.score[1]} tick=${state.tick}`);
      }

      // A conceded point leaves the engine parked at 'point'. applyTick would
      // serve again on the very next decision, which reads as the ball
      // teleporting; instead hold, show 'serving' frames, and serve explicitly.
      if (!ended && state.status === 'point' && serveDelayMs > 0) {
        countingDown = true;
        publishStateNow(snapshot());
        await pause(serveDelayMs);
        countingDown = false;
        if (ended) return;
        state = serve(state);
        publishStateNow(snapshot());
      }
    }
  }

  function startBall(): void {
    if (hasModel) {
      void ballLoop().catch((error: unknown) => {
        log(`ball loop failed: ${describe(error)}`);
        finish('error');
      });
      return;
    }
    ballTimer = setInterval(() => {
      // A serve countdown holds the ball where it is; the paddles keep moving.
      if (ended || countingDown) return;
      state = applyTick(state, 'stay', 'stay');
      publishStateNow(snapshot());
      referee.score(state.score[0], state.score[1]);
      lobbyChanged();
      check();
      if (!ended && state.status === 'point' && serveDelayMs > 0) {
        countingDown = true;
        publishStateNow(snapshot());
        void pause(serveDelayMs).then(() => {
          countingDown = false;
          if (ended) return;
          state = serve(state);
          publishStateNow(snapshot());
        });
      }
    }, HUMAN_BALL_TICK_MS);
  }

  async function shutdown(): Promise<void> {
    stopTimers();
    abort.abort();
    states.stop();
    lobby.stop();

    const final = snapshot({ status: 'over', message: endMessage() });
    // Everything after this point is the close-down sequence: no other publish
    // may follow, however late a callback arrives.
    closed = true;
    onState?.(final);

    try {
      await gameChannel.publish(STATE_MESSAGE, final);
    } catch (error) {
      log(`publish final state failed: ${describe(error)}`);
    }
    try {
      await entered;
    } catch {
      /* already logged by the update handler */
    }
    try {
      await Promise.all([
        gameChannel.presence.leave(agentPresence),
        lobbyChannel.presence.leave(lobbyData('over')),
      ]);
    } catch (error) {
      log(`presence.leave failed: ${describe(error)}`);
    }
    try {
      await Promise.all([gameChannel.detach(), lobbyChannel.detach()]);
    } catch (error) {
      log(`detach failed: ${describe(error)}`);
    }
    client.connection.close();
  }

  try {
    await Promise.all([gameChannel.attach(), lobbyChannel.attach()]);

    // Enter BOTH presence sets before subscribing to anything. A presence event
    // arriving mid-setup calls `lobbyChanged()`, which chains an update onto
    // `entered` — so `entered` has to be the real enter by then, or the update
    // would race ahead of the enter it depends on.
    entered = lobbyChannel.presence.enter(lobbyData('serving'));
    await entered;
    await gameChannel.presence.enter(agentPresence);

    await gameChannel.presence.subscribe(onPresence);
    await gameChannel.subscribe(INPUT_MESSAGE, onInput);

    // Whoever was already on the channel when we attached.
    for (const member of await gameChannel.presence.get()) onPresence(member);

    log(`worker up on ${CHANNELS.game(gameId)} as ${mode} (${laneModel})`);
    paddleTimer = setInterval(onPaddleTick, PADDLE_TICK_MS);

    // A viewer should see a court immediately, not an empty page, even while we
    // are still waiting for the humans this mode needs.
    publishStateNow(snapshot({ status: 'serving' }));

    if (requiredPlayers > 0 && sides.size < requiredPlayers) {
      await Promise.race([readyPromise, endedPromise]);
    }

    // Everyone is here. Give them SERVE_DELAY_MS to find the court and their
    // paddle before the ball moves — the paddle tick publishes a 'serving'
    // frame throughout, which is the "get ready" the client shows.
    if (!ended && played) {
      countingDown = true;
      await pause(SERVE_DELAY_MS);
      countingDown = false;
    }

    if (!ended) {
      waiting = false;
      state = serve(state);
      publishStateNow(snapshot());
      startBall();
    }

    await endedPromise;
  } catch (error) {
    log(`worker failed: ${describe(error)}`);
    stopTimers();
    states.stop();
    lobby.stop();
    closed = true;
    abort.abort();
    try {
      client.connection.close();
    } catch {
      /* nothing left to do */
    }
    throw error;
  }

  await shutdown();

  return {
    reason: endReason,
    score: [state.score[0], state.score[1]],
    ticks: state.tick,
    durationMs: Date.now() - startedAt,
  };
}

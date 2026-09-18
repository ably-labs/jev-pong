'use client';

/**
 * What a page does with Ably: watch a game, or take part in one. No hook here
 * runs a game — that is the worker's job (lib/worker).
 *
 * Nothing reads the lobby. The worker still enters `pong:lobby` presence, which
 * is how `/api/game` counts live games against its cap, but no page lists them:
 * a game is shared by its watch link, not found in a directory.
 *
 * All of them take the connection from the enclosing `<AblyClientProvider>` via
 * `useAbly()`, so there is exactly one WebSocket however many hooks are
 * mounted. Channels and presence membership are taken through `./lease`, which
 * reference-counts them and waits a short grace period before detaching or
 * leaving. That is what makes them safe under React StrictMode's
 * mount/unmount/mount: a spectator does not lose its `rewind` replay to a
 * teardown between the two mounts, and a player does not leave the presence set
 * a moment after joining it.
 *
 * None of these hooks call `setState` synchronously in an effect body. Where a
 * subscription needs to reset — a new `gameId`, a new client — the state
 * carries the identity it belongs to and the reset is derived during render.
 */

import type * as Ably from 'ably';
import { useAbly } from 'ably/react';
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { CHANNELS, type LaneStatus, type Move, type Snapshot } from '../game/types';
import { readPresenceName } from '../ui/name';
import { Coalescer } from './coalesce';
import { GAME_CHANNEL_OPTIONS, leaseChannel, leasePresence } from './lease';
import {
  asGamePresence,
  asSnapshot,
  type GamePresence,
  INPUT_MESSAGE,
  STATE_MESSAGE,
  type InputMessage,
} from './presence';

/* -------------------------------------------------------------- spectating */

export type SpectateState = 'connecting' | 'live' | 'ended' | 'error';

const ENDED_STATUSES: ReadonlySet<LaneStatus> = new Set<LaneStatus>(['over', 'credits', 'error']);

export interface SpectateResult {
  snapshot: Snapshot | null;
  state: SpectateState;
  /**
   * When the latest snapshot arrived on the wire, for the court's motion
   * sampler. Measured in the subscribe callback, not at render time.
   */
  arrivedAtMs?: number;
}

interface SpectateSlice extends SpectateResult {
  gameId: string;
}

/**
 * Follow one game.
 *
 * Attaches with `rewind: '1'`, so a viewer who arrives mid-game gets the last
 * published snapshot immediately rather than waiting for the next tick — which,
 * on a slow model, could be seconds away. That is the whole reason the game
 * channel carries whole snapshots instead of deltas: the last message *is* the
 * state.
 *
 * Rewind reaches back as far as the channel's persistence window (two minutes
 * without persisted history enabled), which is far more than the gap between
 * ticks, so in practice a late joiner is always current.
 */
export function useSpectateGame(gameId: string): SpectateResult {
  const client = useAbly();
  const [slice, setSlice] = useState<SpectateSlice>(() => ({
    gameId,
    snapshot: null,
    state: 'connecting',
  }));

  useEffect(() => {
    if (gameId === '') return;

    let live = true;
    const lease = leaseChannel(client, CHANNELS.game(gameId), GAME_CHANNEL_OPTIONS);
    const channel = lease.channel;

    const onMessage = (message: Ably.InboundMessage): void => {
      if (!live) return;
      const next = asSnapshot(message.data);
      if (next === null) return;
      // Read the clock here, in the callback: the court's sampler times ball
      // steps by arrival, and a render-time stamp would be a frame late.
      const arrivedAtMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
      setSlice({
        gameId,
        snapshot: next,
        state: ENDED_STATUSES.has(next.status) ? 'ended' : 'live',
        arrivedAtMs,
      });
    };

    const onChannelProblem = (): void => {
      if (!live) return;
      setSlice((prev) => (prev.gameId === gameId ? { ...prev, state: 'error' } : prev));
    };

    channel.on(['failed', 'suspended'], onChannelProblem);
    void channel.subscribe(STATE_MESSAGE, onMessage).catch(onChannelProblem);

    return () => {
      live = false;
      channel.off(onChannelProblem);
      channel.unsubscribe(STATE_MESSAGE, onMessage);
      lease.release();
    };
  }, [client, gameId]);

  // Derived, not reset in the effect: a new `gameId` shows as `connecting`
  // from the very first render rather than after a cascading update.
  if (gameId === '') return { snapshot: null, state: 'error' };
  if (slice.gameId !== gameId) return { snapshot: null, state: 'connecting' };
  return { snapshot: slice.snapshot, state: slice.state, arrivedAtMs: slice.arrivedAtMs };
}

/* ------------------------------------------------- game channel presence */

/** A human on a game channel: who they are, and what to call them. */
export interface PlayerMember {
  clientId: string;
  /** The name they gave on the play page, when they gave one. */
  name: string | null;
}

/**
 * A presence entry plus the name that came with it on the wire. `Omit` because
 * the wire's `name` is optional and this one is answered either way.
 */
type GameMember = Omit<GamePresence, 'name'> & { name: string | null };

export interface GamePresenceResult {
  /** Members present as `{ role: 'player' }`, sorted for stable rendering. */
  players: PlayerMember[];
  /** How many members are present as `{ role: 'spectator' }`. */
  viewers: number;
  /** Whether a worker has announced itself as `{ role: 'agent' }`. */
  agentPresent: boolean;
  /** The agent's `model`, when it declared one. */
  agentModel?: string;
}

interface GamePresenceSlice {
  gameId: string;
  members: ReadonlyMap<string, GameMember>;
}

const EMPTY_MEMBERS: ReadonlyMap<string, GameMember> = new Map();

function summarise(members: ReadonlyMap<string, GameMember>): GamePresenceResult {
  const players: PlayerMember[] = [];
  let viewers = 0;
  let agentPresent = false;
  let agentModel: string | undefined;

  for (const [clientId, member] of members) {
    if (member.role === 'player') players.push({ clientId, name: member.name });
    else if (member.role === 'spectator') viewers += 1;
    else if (member.role === 'agent') {
      agentPresent = true;
      if (member.model !== undefined) agentModel = member.model;
    }
  }

  players.sort((a, b) => (a.clientId < b.clientId ? -1 : a.clientId > b.clientId ? 1 : 0));
  return agentModel === undefined
    ? { players, viewers, agentPresent }
    : { players, viewers, agentPresent, agentModel };
}

/**
 * A presence entry as this page uses it.
 *
 * The name is read off the raw payload rather than the guard's result: the
 * guard in ./presence.ts copies out the fields it knows, so a `name` it has not
 * been taught about would be lost on the way through.
 */
function asMember(data: unknown): GameMember | null {
  const member = asGamePresence(data);
  if (member === null) return null;
  return { ...member, name: readPresenceName(data) };
}

/**
 * Who is on a game channel: the humans playing, how many are watching, and
 * whether the worker driving the lane is actually there.
 *
 * `agentPresent` is the honest answer to "is this game alive?" — a lane whose
 * worker has died leaves its last `state` message on the channel, so the
 * snapshot alone cannot tell you.
 */
export function useGamePresence(gameId: string): GamePresenceResult {
  const client = useAbly();
  const [slice, setSlice] = useState<GamePresenceSlice>(() => ({
    gameId,
    members: EMPTY_MEMBERS,
  }));

  useEffect(() => {
    if (gameId === '') return;

    let live = true;
    const members = new Map<string, GameMember>();
    const lease = leaseChannel(client, CHANNELS.game(gameId), GAME_CHANNEL_OPTIONS);
    const channel = lease.channel;

    const commit = (): void => {
      if (!live) return;
      setSlice({ gameId, members: new Map(members) });
    };

    const onPresence = (message: Ably.PresenceMessage): void => {
      if (!live) return;
      const key = message.clientId ?? message.connectionId;
      if (message.action === 'leave' || message.action === 'absent') {
        members.delete(key);
      } else {
        const member = asMember(message.data);
        if (member === null) return;
        members.set(key, member);
      }
      commit();
    };

    void (async () => {
      try {
        await channel.presence.subscribe(onPresence);
        const current = await channel.presence.get();
        if (!live) return;
        for (const message of current) {
          const member = asMember(message.data);
          if (member !== null) members.set(message.clientId ?? message.connectionId, member);
        }
        commit();
      } catch {
        // No presence means an empty roster, not a broken page.
      }
    })();

    return () => {
      live = false;
      channel.presence.unsubscribe(onPresence);
      lease.release();
    };
  }, [client, gameId]);

  const members = slice.gameId === gameId ? slice.members : EMPTY_MEMBERS;
  return useMemo(() => summarise(members), [members]);
}

/* ------------------------------------------------------------- taking part */

/**
 * Minimum gap between `input` publishes: 20 messages a second, which is well
 * inside Ably's per-channel limit and far more than a paddle needs.
 */
export const INPUT_INTERVAL_MS = 50;

/**
 * How often a held direction is repeated on the wire.
 *
 * The worker treats a player's input as expired INPUT_TTL_MS (400 ms) after it
 * arrived, on purpose: a browser that closed its laptop lid must not leave a
 * paddle driving into the wall for the rest of the game. The price of that is
 * that "up", said once, is a paddle that moves for 400 ms and then stops — so
 * while the key is down we say it again, comfortably inside the window even if
 * a message is lost. Two and a half messages a second, and only while a key is
 * actually held.
 */
export const INPUT_KEEPALIVE_MS = 150;

export interface PlayerInputResult {
  /**
   * Send a paddle move. Identical consecutive moves are dropped — the keepalive
   * above is what renews a held one, so nothing is lost by saying it again.
   */
  sendInput(move: Move): void;
  /** True once this client is in the game's presence set as a player. */
  ready: boolean;
  /**
   * The `seq` of the newest input put on the wire for this game, 0 before the
   * first. A frame whose `inputSeq` for our side has reached it was taken after
   * the worker applied everything we have said — which is when the locally
   * predicted paddle may be reconciled against it (lib/ui/paddle.ts). A ref,
   * because the court reads it on every animation frame.
   */
  sentSeq: RefObject<number>;
}

/**
 * Join a game as the human on the left paddle and send input.
 *
 * Inputs are level-triggered, not edge-triggered: the UI can call `sendInput`
 * on every animation frame and only actual changes reach the wire. Holding a
 * key therefore costs a message every INPUT_KEEPALIVE_MS, not sixty a second.
 *
 * Two rules make the paddle behave, and both are about the far end forgetting:
 * a held direction is REPEATED every INPUT_KEEPALIVE_MS so the worker's
 * INPUT_TTL_MS never expires it mid-press, and a 'stay' is URGENT — it goes out
 * the instant the key comes up rather than waiting for the rate limit, because
 * a late stop is a paddle that has already run past where you let go.
 *
 * Every message carries a `seq`, counted from 1 per game, and the worker echoes
 * the newest one it has applied in each frame — see `sentSeq` above.
 *
 * `name` goes into the presence data, which is the only place it exists: the
 * feed and the watch page read it back off the channel rather than being told
 * it. An empty name is left off entirely, so a spectator sees anon-XXXX.
 */
export function usePlayerInput(gameId: string | null, name?: string | null): PlayerInputResult {
  const client = useAbly();
  const [readyFor, setReadyFor] = useState<string | null>(null);
  const coalescerRef = useRef<Coalescer<Move> | null>(null);
  const sentSeq = useRef(0);

  useEffect(() => {
    if (gameId === null || gameId === '') return;

    let live = true;
    sentSeq.current = 0;
    const presence: GamePresence & { name?: string } = name
      ? { role: 'player', name }
      : { role: 'player' };
    const lease = leasePresence(client, CHANNELS.game(gameId), presence, {
      channelOptions: GAME_CHANNEL_OPTIONS,
    });
    const channel = lease.channel;

    const coalescer = new Coalescer<Move>({
      intervalMs: INPUT_INTERVAL_MS,
      keepAliveMs: INPUT_KEEPALIVE_MS,
      isHeld: (move) => move !== 'stay',
      isUrgent: (move, lastEmitted) => move === 'stay' && lastEmitted !== 'stay',
      emit: (move) => {
        sentSeq.current += 1;
        const input: InputMessage = { move, seq: sentSeq.current };
        void channel.publish(INPUT_MESSAGE, input).catch(() => {
          // A dropped input is corrected by the next one; never break the page.
        });
      },
    });
    coalescerRef.current = coalescer;

    void lease.entered.then(() => {
      if (live) setReadyFor(gameId);
    });

    return () => {
      live = false;
      // A move still waiting for the interval is the paddle's real position.
      // Dropping it is how a paddle ends up stuck at the top of the court for
      // the rest of the game, so it goes out before anything is torn down.
      coalescer.flush();
      coalescer.stop();
      if (coalescerRef.current === coalescer) coalescerRef.current = null;
      lease.release();
    };
  }, [client, gameId, name]);

  const sendInput = useCallback((move: Move) => {
    const coalescer = coalescerRef.current;
    if (coalescer === null) return;
    // Drop a repeat of whatever is already queued, or of the last thing sent.
    const outstanding = coalescer.pending ?? coalescer.lastEmitted;
    if (outstanding === move) return;
    coalescer.push(move);
  }, []);

  return { sendInput, ready: gameId !== null && gameId !== '' && readyFor === gameId, sentSeq };
}

/**
 * Be counted as a viewer of a game.
 *
 * Enters the game channel's presence set as `{ role: 'spectator' }` and leaves
 * on unmount. That set is the "N watching" number on the play and watch pages,
 * and it is also what keeps a demo game alive — the worker stops one nobody is
 * watching. Pair it with {@link useSpectateGame} on a watch page.
 */
export function useSpectatorPresence(gameId: string | null): void {
  const client = useAbly();

  useEffect(() => {
    if (gameId === null || gameId === '') return;
    const lease = leasePresence(client, CHANNELS.game(gameId), { role: 'spectator' }, {
      channelOptions: GAME_CHANNEL_OPTIONS,
    });
    return () => {
      lease.release();
    };
  }, [client, gameId]);
}

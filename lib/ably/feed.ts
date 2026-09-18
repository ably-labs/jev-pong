'use client';

/**
 * The join feed: who arrived on this game's channel, and when.
 *
 * It is the only thing on the page that makes the Ably part visible. Everyone
 * — the player, the agent that runs the lane, every spectator — is a member of
 * `pong:game:<id>`, so the feed is simply that presence set narrated in the
 * order it happened:
 *
 *   0:00  you joined
 *   0:01  Jev joined
 *   0:12  anon-91be is watching
 *
 * Times are measured from when the page mounted, not from wall-clock, because
 * "0:12" should mean "twelve seconds after you got here".
 */

import type * as Ably from 'ably';
import { useAbly } from 'ably/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { CHANNELS, LANES } from '../game/types';
import { readPresenceName } from '../ui/name';
import { GAME_CHANNEL_OPTIONS, leaseChannel } from './lease';
import { asGamePresence, type GamePresence } from './presence';

/** How long a new line stays bold before it goes muted (motion note 06). */
export const FRESH_MS = 3000;
/** Most lines the feed will ever show. */
export const FEED_LIMIT = 6;

export type FeedKind = 'you' | 'agent' | 'player' | 'watcher' | 'left';

export interface FeedLine {
  /** Stable key. */
  id: string;
  /** Milliseconds since the page mounted. */
  atMs: number;
  /** "0:12" */
  time: string;
  text: string;
  kind: FeedKind;
  /** Bold for the first three seconds, then muted. */
  fresh: boolean;
}

const LANE_LABELS = new Map<string, string>(LANES.map((lane) => [lane.id, lane.label]));

/** "pong-4f3ac2be1d" -> "anon-be1d". The last four characters, always. */
export function anonName(clientId: string | null | undefined): string {
  if (!clientId) return 'anon-????';
  return `anon-${clientId.slice(-4)}`;
}

/** Shown wherever a name is not knowable yet. Never a guess. */
export const CONNECTING = 'connecting\u2026';

/**
 * What to call somebody on screen.
 *
 * A name they typed wins. Failing that it is the anon name built from their
 * Ably clientId. Before the connection has a clientId there is no honest answer
 * yet, so it says so rather than showing "anon-????" and then changing its mind.
 */
export function displayName(clientId: string | null | undefined, name?: string | null): string {
  if (name) return name;
  if (!clientId) return CONNECTING;
  return anonName(clientId);
}

/** "4f3ac2be" -> "game:c2be". The channel label on the card. */
export function channelLabel(gameId: string): string {
  return `game:${gameId.slice(-4)}`;
}

/**
 * The lobby only knows a game by its id — the player's own clientId never
 * reaches it — so a lobby row names the game after the channel it is on. The
 * player's own page uses {@link anonName} on their real clientId.
 */
export function anonForGame(gameId: string): string {
  return `anon-${gameId.slice(-4)}`;
}

/** The agent's own name for itself, prettified when this build knows the id. */
export function agentName(model: string | undefined): string {
  if (model === undefined) return 'The agent';
  return LANE_LABELS.get(model) ?? model;
}

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  return `${mm}:${String(ss).padStart(2, '0')}`;
}

/** What a presence event reads as on the feed. */
export function feedTextFor(
  member: GamePresence,
  clientId: string,
  self: boolean,
  leaving: boolean,
  name?: string | null,
): { text: string; kind: FeedKind } {
  const who =
    member.role === 'agent'
      ? agentName(member.model)
      : (name ?? (self ? 'you' : anonName(clientId)));
  if (leaving) return { text: `${who} left`, kind: 'left' };
  if (member.role === 'agent') return { text: `${who} joined`, kind: 'agent' };
  if (member.role === 'spectator') {
    return self
      ? { text: 'you are watching', kind: 'you' }
      : { text: `${who} is watching`, kind: 'watcher' };
  }
  return { text: `${who} joined`, kind: self ? 'you' : 'player' };
}

/**
 * The feed for one game. Must be called inside `<AblyClientProvider>`.
 *
 * It takes its own hold on the game channel through `leaseChannel`, so it
 * shares the one the spectate and presence hooks already have rather than
 * opening a second.
 */
export function useGameFeed(gameId: string): FeedLine[] {
  const client = useAbly();
  // The feed carries the game it belongs to, so a new game starts empty in the
  // same render rather than through a reset in an effect.
  const [slice, setSlice] = useState<{ gameId: string; lines: FeedLine[] }>({
    gameId,
    lines: [],
  });
  const timers = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  // Kept in refs so StrictMode's double mount cannot replay a key: ids stay
  // unique across effect runs and a member seen once is not announced twice.
  const seenRef = useRef(new Set<string>());
  const seqRef = useRef(0);

  const stale = useCallback((game: string, id: string) => {
    setSlice((prev) =>
      prev.gameId === game
        ? { ...prev, lines: prev.lines.map((l) => (l.id === id ? { ...l, fresh: false } : l)) }
        : prev,
    );
  }, []);

  useEffect(() => {
    if (gameId === '') return;

    let live = true;
    const mountedAt = Date.now();
    const seen = seenRef.current;
    const pending = timers.current;
    const lease = leaseChannel(client, CHANNELS.game(gameId), GAME_CHANNEL_OPTIONS);
    const channel = lease.channel;
    const me = client.auth.clientId ?? null;


    const push = (message: Ably.PresenceMessage, leaving: boolean): void => {
      if (!live) return;
      const member = asGamePresence(message.data);
      if (member === null) return;
      const clientId = message.clientId ?? message.connectionId;
      const key = `${clientId}:${leaving ? 'leave' : member.role}`;
      if (seen.has(key)) return;
      seen.add(key);

      const atMs = Date.now() - mountedAt;
      const { text, kind } = feedTextFor(
        member,
        clientId,
        clientId === me,
        leaving,
        readPresenceName(message.data),
      );
      seqRef.current += 1;
      const id = `${key}:${seqRef.current}`;
      const line: FeedLine = { id, atMs, time: formatElapsed(atMs), text, kind, fresh: true };
      setSlice((prev) =>
        prev.gameId === gameId ? { gameId, lines: [...prev.lines, line].slice(-FEED_LIMIT) } : prev,
      );
      pending.push(setTimeout(() => stale(gameId, id), FRESH_MS));
    };

    const onPresence = (message: Ably.PresenceMessage): void => {
      push(message, message.action === 'leave' || message.action === 'absent');
    };

    void (async () => {
      try {
        await channel.presence.subscribe(onPresence);
        const current = await channel.presence.get();
        if (!live) return;
        for (const message of current) push(message, false);
      } catch {
        // A channel we cannot read simply has no feed.
      }
    })();

    return () => {
      live = false;
      for (const timer of pending) clearTimeout(timer);
      pending.length = 0;
      channel.presence.unsubscribe(onPresence);
      lease.release();
    };
  }, [client, gameId, stale]);

  if (slice.gameId !== gameId) {
    setSlice({ gameId, lines: [] });
    return [];
  }
  return slice.lines;
}

/**
 * This browser's own Ably clientId, once the connection has one.
 *
 * It is null until the token comes back, so the page shows "anon-…" for a
 * moment rather than guessing a name it would then have to change.
 */
export function useSelfClientId(): string | null {
  const client = useAbly();
  const [id, setId] = useState<string | null>(client.auth.clientId ?? null);

  useEffect(() => {
    if (id !== null) return;
    const listener = (): void => {
      const current = client.auth.clientId ?? null;
      if (current !== null) setId(current);
    };
    client.connection.on(listener);
    listener();
    return () => client.connection.off(listener);
  }, [client, id]);

  return id;
}

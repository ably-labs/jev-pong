/**
 * Reference-counted channel handles.
 *
 * Two problems this solves:
 *
 * 1. React StrictMode mounts an effect, tears it down, and mounts it again. A
 *    naive `detach()` in the teardown would detach the channel between the two
 *    mounts — and `rewind` only replays on a channel's *initial* attach, so a
 *    spectator would lose the very message the rewind exists to deliver. A
 *    grace period means the second mount re-takes the still-attached channel.
 *
 * 2. More than one thing can want the same channel at once (a watch page reads
 *    `state` and is separately present as a spectator on it). Whoever finishes
 *    first must not detach the channel out from under the other.
 *
 * `leaseChannel` is plain TypeScript — no React, and Ably is a type-only import,
 * so this module can be exercised with a fake client.
 */

import type * as Ably from 'ably';

/** Default wait before detaching a channel nobody holds any more. */
export const DETACH_GRACE_MS = 400;

/**
 * The options every holder of a game channel must ask for.
 *
 * Channel options are fixed by whoever creates the channel, and `rewind` only
 * takes effect on the first attach. A watch page holds the same channel twice —
 * once to read `state`, once to be counted in presence — so if the presence
 * hold got there first with no options, the spectator would silently lose the
 * replay that makes a late join instant. One shared constant, requested
 * everywhere, removes the ordering question.
 */
export const GAME_CHANNEL_OPTIONS: Ably.ChannelOptions = { params: { rewind: '1' } };

interface Entry {
  channel: Ably.RealtimeChannel;
  holders: number;
  detachTimer: TimerId | null;
}

type TimerId = ReturnType<typeof setTimeout>;

const registries = new WeakMap<object, Map<string, Entry>>();

export interface ChannelLease {
  readonly channel: Ably.RealtimeChannel;
  /** Give up this hold. The channel detaches once the last hold is released. */
  release(): void;
}

/**
 * Take a hold on `name`. `options` are applied only when the channel is first
 * created for this client, so a second holder cannot silently change the
 * channel params underneath the first.
 *
 * @param graceMs milliseconds to wait, after the last release, before detaching.
 *   Pass `0` to detach synchronously, which is what the tests do; every hook
 *   takes the default grace.
 */
export function leaseChannel(
  client: Ably.RealtimeClient,
  name: string,
  options?: Ably.ChannelOptions,
  graceMs: number = DETACH_GRACE_MS,
): ChannelLease {
  let registry = registries.get(client);
  if (registry === undefined) {
    registry = new Map<string, Entry>();
    registries.set(client, registry);
  }
  const channels = registry;

  let entry = channels.get(name);
  if (entry === undefined) {
    entry = { channel: client.channels.get(name, options), holders: 0, detachTimer: null };
    channels.set(name, entry);
  }
  if (entry.detachTimer !== null) {
    clearTimeout(entry.detachTimer);
    entry.detachTimer = null;
  }
  entry.holders += 1;

  const held = entry;
  let released = false;

  const teardown = (): void => {
    held.detachTimer = null;
    if (held.holders > 0) return;
    if (channels.get(name) === held) channels.delete(name);
    void held.channel.detach().catch(() => {
      // A channel that will not detach is already gone as far as we care.
    });
    client.channels.release(name);
  };

  return {
    get channel(): Ably.RealtimeChannel {
      return held.channel;
    },
    release(): void {
      if (released) return;
      released = true;
      held.holders -= 1;
      if (held.holders > 0) return;
      if (graceMs <= 0) {
        teardown();
        return;
      }
      held.detachTimer = setTimeout(teardown, graceMs);
    },
  };
}

/** Number of live holds on a channel. Exposed for tests and diagnostics. */
export function leaseCount(client: Ably.RealtimeClient, name: string): number {
  return registries.get(client)?.get(name)?.holders ?? 0;
}

/* ------------------------------------------------------- presence membership */

/**
 * The same idea for presence membership.
 *
 * A connection has exactly one member per presence set, so entering twice is
 * not "two members" — it is one member whose data was overwritten. That makes
 * leaving on unmount dangerous under StrictMode: the leave from the first
 * teardown would land after the second mount's enter and drop the member
 * altogether. Reference counting plus the same grace period fixes both.
 */
export interface PresenceLease {
  readonly channel: Ably.RealtimeChannel;
  /** Resolves once this connection is in the presence set (or the enter failed). */
  readonly entered: Promise<void>;
  /** Replace this connection's presence data. */
  update(data: unknown): Promise<void>;
  release(): void;
}

interface PresenceEntry {
  lease: ChannelLease;
  holders: number;
  leaveTimer: TimerId | null;
  entered: Promise<void>;
}

const presenceRegistries = new WeakMap<object, Map<string, PresenceEntry>>();

/**
 * Enter the presence set of `name` and stay there until the last holder
 * releases.
 *
 * A second acquire while one is already live does not re-enter; it updates the
 * data instead, so the most recent caller wins without a leave/enter flicker.
 */
export interface PresenceLeaseOptions {
  /** Channel options to request if this is what creates the channel. */
  channelOptions?: Ably.ChannelOptions;
  /** Wait before leaving once the last holder releases. */
  graceMs?: number;
}

export function leasePresence(
  client: Ably.RealtimeClient,
  name: string,
  data: unknown,
  options: PresenceLeaseOptions = {},
): PresenceLease {
  const { channelOptions, graceMs = DETACH_GRACE_MS } = options;
  let registry = presenceRegistries.get(client);
  if (registry === undefined) {
    registry = new Map<string, PresenceEntry>();
    presenceRegistries.set(client, registry);
  }
  const members = registry;

  let entry = members.get(name);
  if (entry === undefined) {
    const lease = leaseChannel(client, name, channelOptions, graceMs);
    entry = {
      lease,
      holders: 0,
      leaveTimer: null,
      entered: lease.channel.presence.enter(data).catch(() => {
        // Reported by whoever awaits `entered`; a failed enter must not become
        // an unhandled rejection.
      }),
    };
    members.set(name, entry);
  } else {
    void entry.entered.then(() => entry?.lease.channel.presence.update(data)).catch(() => {});
  }
  if (entry.leaveTimer !== null) {
    clearTimeout(entry.leaveTimer);
    entry.leaveTimer = null;
  }
  entry.holders += 1;

  const held = entry;
  let released = false;

  const leave = (): void => {
    held.leaveTimer = null;
    if (held.holders > 0) return;
    if (members.get(name) === held) members.delete(name);
    void held.entered
      .then(() => held.lease.channel.presence.leave())
      .catch(() => {
        // Leaving a set we never joined is not a problem worth surfacing.
      })
      .finally(() => {
        held.lease.release();
      });
  };

  return {
    get channel(): Ably.RealtimeChannel {
      return held.lease.channel;
    },
    get entered(): Promise<void> {
      return held.entered;
    },
    update(next: unknown): Promise<void> {
      return held.entered.then(() => held.lease.channel.presence.update(next));
    },
    release(): void {
      if (released) return;
      released = true;
      held.holders -= 1;
      if (held.holders > 0) return;
      if (graceMs <= 0) {
        leave();
        return;
      }
      held.leaveTimer = setTimeout(leave, graceMs);
    },
  };
}

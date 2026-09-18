import type * as Ably from 'ably';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DETACH_GRACE_MS,
  GAME_CHANNEL_OPTIONS,
  leaseChannel,
  leaseCount,
  leasePresence,
} from './lease';

class FakePresence {
  readonly entered: unknown[] = [];
  readonly updated: unknown[] = [];
  left = 0;

  enter(data: unknown): Promise<void> {
    this.entered.push(data);
    return Promise.resolve();
  }

  update(data: unknown): Promise<void> {
    this.updated.push(data);
    return Promise.resolve();
  }

  leave(): Promise<void> {
    this.left += 1;
    return Promise.resolve();
  }
}

class FakeChannel {
  readonly presence = new FakePresence();
  detached = 0;

  constructor(
    readonly name: string,
    readonly options?: Ably.ChannelOptions,
  ) {}

  detach(): Promise<void> {
    this.detached += 1;
    return Promise.resolve();
  }
}

class FakeChannels {
  readonly created: FakeChannel[] = [];
  readonly byName = new Map<string, FakeChannel>();
  readonly released: string[] = [];

  get(name: string, options?: Ably.ChannelOptions): FakeChannel {
    let channel = this.byName.get(name);
    if (channel === undefined) {
      channel = new FakeChannel(name, options);
      this.byName.set(name, channel);
      this.created.push(channel);
    }
    return channel;
  }

  release(name: string): void {
    this.released.push(name);
    this.byName.delete(name);
  }
}

function fakeClient(): { client: Ably.RealtimeClient; channels: FakeChannels } {
  const channels = new FakeChannels();
  return { client: { channels } as unknown as Ably.RealtimeClient, channels };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('leaseChannel', () => {
  it('creates the channel once and shares it', () => {
    const { client, channels } = fakeClient();

    const a = leaseChannel(client, 'pong:lobby');
    const b = leaseChannel(client, 'pong:lobby');

    expect(channels.created).toHaveLength(1);
    expect(a.channel).toBe(b.channel);
    expect(leaseCount(client, 'pong:lobby')).toBe(2);
  });

  it('applies channel options only when the channel is first created', () => {
    const { client, channels } = fakeClient();

    leaseChannel(client, 'pong:game:x', { params: { rewind: '1' } });
    leaseChannel(client, 'pong:game:x', { params: { rewind: '99' } });

    expect(channels.created[0].options).toEqual({ params: { rewind: '1' } });
  });

  it('does not detach while another holder remains', () => {
    const { client, channels } = fakeClient();
    const a = leaseChannel(client, 'pong:lobby');
    leaseChannel(client, 'pong:lobby');

    a.release();
    vi.advanceTimersByTime(DETACH_GRACE_MS * 2);

    expect(channels.created[0].detached).toBe(0);
  });

  it('detaches after the grace period once the last holder releases', () => {
    const { client, channels } = fakeClient();
    const a = leaseChannel(client, 'pong:lobby');

    a.release();
    expect(channels.created[0].detached).toBe(0);

    vi.advanceTimersByTime(DETACH_GRACE_MS);

    expect(channels.created[0].detached).toBe(1);
    expect(channels.released).toEqual(['pong:lobby']);
  });

  it('survives a StrictMode remount: release then re-acquire inside the grace', () => {
    const { client, channels } = fakeClient();

    const first = leaseChannel(client, 'pong:game:x', { params: { rewind: '1' } });
    first.release();
    const second = leaseChannel(client, 'pong:game:x', { params: { rewind: '1' } });

    vi.advanceTimersByTime(DETACH_GRACE_MS * 2);

    expect(channels.created).toHaveLength(1);
    expect(channels.created[0].detached).toBe(0);
    expect(second.channel).toBe(channels.created[0]);
  });

  it('detaches synchronously when the grace is zero', () => {
    const { client, channels } = fakeClient();

    leaseChannel(client, 'pong:lobby', undefined, 0).release();

    expect(channels.created[0].detached).toBe(1);
  });

  it('ignores a repeated release', () => {
    const { client, channels } = fakeClient();
    const a = leaseChannel(client, 'pong:lobby');
    leaseChannel(client, 'pong:lobby');

    a.release();
    a.release();
    vi.advanceTimersByTime(DETACH_GRACE_MS * 2);

    expect(channels.created[0].detached).toBe(0);
    expect(leaseCount(client, 'pong:lobby')).toBe(1);
  });
});

describe('leasePresence', () => {
  it('enters the presence set once', () => {
    const { client, channels } = fakeClient();

    leasePresence(client, 'pong:game:x', { role: 'spectator' });

    expect(channels.created[0].presence.entered).toEqual([{ role: 'spectator' }]);
  });

  it('updates rather than re-entering for a second holder', async () => {
    const { client, channels } = fakeClient();

    leasePresence(client, 'pong:game:x', { role: 'spectator' });
    leasePresence(client, 'pong:game:x', { role: 'player' });
    await settle();

    const presence = channels.created[0].presence;
    expect(presence.entered).toEqual([{ role: 'spectator' }]);
    expect(presence.updated).toEqual([{ role: 'player' }]);
  });

  it('does not leave while another holder remains', async () => {
    const { client, channels } = fakeClient();
    const a = leasePresence(client, 'pong:game:x', { role: 'spectator' });
    leasePresence(client, 'pong:game:x', { role: 'spectator' });

    a.release();
    vi.advanceTimersByTime(DETACH_GRACE_MS * 2);
    await settle();

    expect(channels.created[0].presence.left).toBe(0);
  });

  it('leaves and detaches after the grace once the last holder releases', async () => {
    const { client, channels } = fakeClient();
    const lease = leasePresence(client, 'pong:game:x', { role: 'player' });

    lease.release();
    expect(channels.created[0].presence.left).toBe(0);

    vi.advanceTimersByTime(DETACH_GRACE_MS);
    await settle();

    expect(channels.created[0].presence.left).toBe(1);

    // Leaving releases the channel hold, which then runs its own grace period.
    vi.advanceTimersByTime(DETACH_GRACE_MS);
    await settle();

    expect(channels.created[0].detached).toBe(1);
  });

  it('survives a StrictMode remount without leaving the presence set', async () => {
    const { client, channels } = fakeClient();

    const first = leasePresence(client, 'pong:game:x', { role: 'player' });
    first.release();
    leasePresence(client, 'pong:game:x', { role: 'player' });

    vi.advanceTimersByTime(DETACH_GRACE_MS * 2);
    await settle();

    const presence = channels.created[0].presence;
    expect(presence.entered).toHaveLength(1);
    expect(presence.left).toBe(0);
    expect(channels.created[0].detached).toBe(0);
  });

  it('exposes an update method that waits for the enter', async () => {
    const { client, channels } = fakeClient();
    const lease = leasePresence(client, 'pong:game:x', { role: 'spectator' });

    await lease.update({ role: 'player' });

    expect(channels.created[0].presence.updated).toEqual([{ role: 'player' }]);
  });

  it('applies the channel options it was given', () => {
    const { client, channels } = fakeClient();

    leasePresence(
      client,
      'pong:game:x',
      { role: 'spectator' },
      { channelOptions: GAME_CHANNEL_OPTIONS },
    );

    expect(channels.created[0].options).toEqual(GAME_CHANNEL_OPTIONS);
  });

  it('keeps rewind whichever hold reaches the game channel first', () => {
    // A watch page holds the channel twice. Either order must end up with the
    // rewind params, or a late joiner silently loses its replay.
    const presenceFirst = fakeClient();
    leasePresence(
      presenceFirst.client,
      'pong:game:x',
      { role: 'spectator' },
      { channelOptions: GAME_CHANNEL_OPTIONS },
    );
    leaseChannel(presenceFirst.client, 'pong:game:x', GAME_CHANNEL_OPTIONS);

    const subscribeFirst = fakeClient();
    leaseChannel(subscribeFirst.client, 'pong:game:x', GAME_CHANNEL_OPTIONS);
    leasePresence(
      subscribeFirst.client,
      'pong:game:x',
      { role: 'spectator' },
      { channelOptions: GAME_CHANNEL_OPTIONS },
    );

    expect(presenceFirst.channels.created[0].options).toEqual({ params: { rewind: '1' } });
    expect(subscribeFirst.channels.created[0].options).toEqual({ params: { rewind: '1' } });
    expect(presenceFirst.channels.created).toHaveLength(1);
    expect(subscribeFirst.channels.created).toHaveLength(1);
  });
});

/**
 * In-memory Ably, for testing the worker.
 *
 * It implements the same `AblyLike` interface the worker takes in production,
 * so a test drives the real worker: real engine, real referee, real coalescing,
 * real shutdown sequence. Only the wire is fake.
 *
 * Everything that went out is recorded with the (fake) clock time it went out
 * at, which is what lets a test assert publish RATES and not just counts.
 */

import type {
  AblyClientOptions,
  AblyLike,
  ChannelLike,
  MessageLike,
  PresenceLike,
  PresenceMemberLike,
} from './ably-like';

export interface RecordedPublish {
  name: string;
  data: unknown;
  at: number;
}

export interface RecordedPresence {
  action: 'enter' | 'update' | 'leave';
  data: unknown;
  at: number;
}

export class FakeChannel implements ChannelLike {
  readonly published: RecordedPublish[] = [];
  readonly presenceCalls: RecordedPresence[] = [];
  attachCount = 0;
  detachCount = 0;

  /** Members `presence.get()` reports. Seed it before the worker starts. */
  readonly members: PresenceMemberLike[] = [];

  private readonly presenceListeners: Array<(member: PresenceMemberLike) => void> = [];
  private readonly listeners = new Map<string, Array<(message: MessageLike) => void>>();

  constructor(readonly name: string) {}

  readonly presence: PresenceLike = {
    enter: async (data?: unknown) => {
      this.presenceCalls.push({ action: 'enter', data, at: Date.now() });
    },
    update: async (data?: unknown) => {
      this.presenceCalls.push({ action: 'update', data, at: Date.now() });
    },
    leave: async (data?: unknown) => {
      this.presenceCalls.push({ action: 'leave', data, at: Date.now() });
    },
    get: async () => [...this.members],
    subscribe: async (listener: (member: PresenceMemberLike) => void) => {
      this.presenceListeners.push(listener);
    },
  };

  async attach(): Promise<void> {
    this.attachCount += 1;
  }

  async detach(): Promise<void> {
    this.detachCount += 1;
  }

  async publish(name: string, data: unknown): Promise<void> {
    this.published.push({ name, data, at: Date.now() });
  }

  async subscribe(name: string, listener: (message: MessageLike) => void): Promise<void> {
    const existing = this.listeners.get(name);
    if (existing === undefined) this.listeners.set(name, [listener]);
    else existing.push(listener);
  }

  /* ------------------------------------------------------------- test input */

  /** Deliver a presence event, as Ably would. */
  emitPresence(action: string, clientId: string, data?: unknown): void {
    for (const listener of [...this.presenceListeners]) listener({ action, clientId, data });
  }

  /** Deliver a channel message, as Ably would, with the publisher's clientId. */
  emitMessage(name: string, clientId: string, data: unknown): void {
    for (const listener of this.listeners.get(name) ?? []) listener({ name, clientId, data });
  }

  /** Everything published under `name`, newest last. */
  messages(name: string): RecordedPublish[] {
    return this.published.filter((entry) => entry.name === name);
  }
}

export class FakeAbly implements AblyLike {
  readonly options: AblyClientOptions;
  readonly created = new Map<string, FakeChannel>();
  closeCount = 0;

  constructor(options: AblyClientOptions) {
    this.options = options;
  }

  readonly channels = {
    get: (name: string): FakeChannel => {
      const existing = this.created.get(name);
      if (existing !== undefined) return existing;
      const channel = new FakeChannel(name);
      this.created.set(name, channel);
      return channel;
    },
  };

  readonly connection = {
    close: (): void => {
      this.closeCount += 1;
    },
  };

  /** The channel at `name`, created if the worker has not asked for it yet. */
  channel(name: string): FakeChannel {
    return this.channels.get(name);
  }
}

/**
 * The slice of Ably the game worker actually uses.
 *
 * `Ably.Realtime` satisfies this structurally, so the worker takes the real
 * client in production and an in-memory fake in tests without either side
 * knowing. Nothing here imports `ably`: the interfaces are deliberately the
 * narrow subset the worker calls, which is also the contract the fake has to
 * honour for a test to mean anything.
 */

/** A member of a presence set, as both `presence.get()` and events deliver it. */
export interface PresenceMemberLike {
  clientId?: string;
  /** 'enter' | 'present' | 'update' | 'leave' | 'absent'. */
  action?: string;
  data?: unknown;
}

/** A channel message. `clientId` is stamped by Ably from the publisher's identity. */
export interface MessageLike {
  name?: string;
  clientId?: string;
  data?: unknown;
}

export interface PresenceLike {
  enter(data?: unknown): Promise<void>;
  update(data?: unknown): Promise<void>;
  leave(data?: unknown): Promise<void>;
  get(params?: { waitForSync?: boolean }): Promise<PresenceMemberLike[]>;
  subscribe(listener: (member: PresenceMemberLike) => void): Promise<unknown> | void;
}

export interface ChannelLike {
  readonly name: string;
  readonly presence: PresenceLike;
  attach(): Promise<unknown>;
  detach(): Promise<unknown>;
  publish(name: string, data: unknown): Promise<unknown>;
  subscribe(name: string, listener: (message: MessageLike) => void): Promise<unknown> | void;
}

export interface AblyLike {
  readonly channels: { get(name: string): ChannelLike };
  readonly connection: { close(): void };
}

/** What the worker asks for when it builds its own client. */
export interface AblyClientOptions {
  key: string;
  clientId: string;
  echoMessages: boolean;
}

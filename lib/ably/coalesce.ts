/**
 * Rate control for anything that publishes to Ably.
 *
 * A lane can tick faster than it is worth putting on the wire (Jev does ~10/s,
 * and the engine can burst). Spectators only ever render the newest snapshot,
 * so intermediate ones are dead weight — but a *status* change (serve, point,
 * game over, error) must never be delayed or dropped, because it is the thing
 * the UI reacts to.
 *
 * The other half of the policy is the opposite problem. A player's paddle input
 * is a LEVEL, not an event, and the worker forgets it after INPUT_TTL_MS — so a
 * held direction that is never repeated is a paddle that stops halfway. That is
 * what `keepAliveMs` is for: a value the caller calls "held" is re-emitted on
 * its own timer until something replaces it.
 *
 * `Coalescer` is that policy, with no Ably and no timers of its own that a test
 * cannot control: pass `now`/`setTimer`/`clearTimer` to drive it deterministically,
 * or leave them out and it uses the globals (which `vi.useFakeTimers()` replaces).
 */

export type TimerId = ReturnType<typeof setTimeout>;

export interface CoalescerOptions<T> {
  /** Minimum milliseconds between two emits. */
  intervalMs: number;
  /** Called with the value that should go on the wire. Never called with a stale value. */
  emit: (value: T) => void;
  /**
   * Values for which the interval does not apply — they are emitted at once and
   * supersede anything queued. Defaults to "nothing is urgent".
   */
  isUrgent?: (next: T, lastEmitted: T | null) => boolean;
  /**
   * Re-emit the last value this often while `isHeld` says it is still being
   * held, with nothing new pushed. Off by default: most streams say something
   * new often enough that a repeat is noise.
   */
  keepAliveMs?: number;
  /** Which values are a held level that has to be renewed. Default: none. */
  isHeld?: (value: T) => boolean;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => TimerId;
  clearTimer?: (id: TimerId) => void;
}

/**
 * Throttle that keeps only the latest value.
 *
 * Leading edge: the first push after a quiet period emits immediately.
 * Trailing edge: pushes inside the interval are held and the newest one is
 * emitted when the interval expires. Order is therefore always preserved —
 * what is dropped is only ever a value that a newer one replaced.
 */
export class Coalescer<T> {
  private readonly intervalMs: number;
  private readonly emitValue: (value: T) => void;
  private readonly urgent: (next: T, lastEmitted: T | null) => boolean;
  private readonly keepAliveMs: number;
  private readonly held: (value: T) => boolean;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => TimerId;
  private readonly clearTimer: (id: TimerId) => void;

  private timer: TimerId | null = null;
  private keepAliveTimer: TimerId | null = null;
  private queued: T | null = null;
  private hasQueued = false;
  private last: T | null = null;
  private lastEmitAt = Number.NEGATIVE_INFINITY;
  private stopped = false;

  constructor(options: CoalescerOptions<T>) {
    this.intervalMs = options.intervalMs;
    this.emitValue = options.emit;
    this.urgent = options.isUrgent ?? (() => false);
    this.keepAliveMs = options.keepAliveMs ?? 0;
    this.held = options.isHeld ?? (() => false);
    this.now = options.now ?? (() => Date.now());
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((id) => clearTimeout(id));
  }

  /** The value waiting to be emitted, if any. */
  get pending(): T | null {
    return this.hasQueued ? this.queued : null;
  }

  /** The most recent value actually emitted. */
  get lastEmitted(): T | null {
    return this.last;
  }

  /** Offer a value. It is emitted now, held, or it replaces the held one. */
  push(value: T): void {
    if (this.stopped) return;

    if (this.urgent(value, this.last)) {
      this.cancelTimer();
      this.discardQueued();
      this.emitNow(value);
      return;
    }

    const elapsed = this.now() - this.lastEmitAt;
    if (this.timer === null && elapsed >= this.intervalMs) {
      this.emitNow(value);
      return;
    }

    this.queued = value;
    this.hasQueued = true;
    if (this.timer === null) {
      const wait = Math.max(0, this.intervalMs - elapsed);
      this.timer = this.setTimer(() => {
        this.timer = null;
        this.flush();
      }, wait);
    }
  }

  /** Emit whatever is held, immediately. No-op when nothing is held. */
  flush(): void {
    if (this.stopped) return;
    this.cancelTimer();
    if (!this.hasQueued) return;
    const value = this.queued as T;
    this.discardQueued();
    this.emitNow(value);
  }

  /** Stop accepting and emitting. Anything still held is dropped — `flush()` first if it matters. */
  stop(): void {
    this.stopped = true;
    this.cancelTimer();
    this.cancelKeepAlive();
    this.discardQueued();
  }

  private emitNow(value: T): void {
    this.last = value;
    this.lastEmitAt = this.now();
    this.emitValue(value);
    this.scheduleKeepAlive(value);
  }

  /**
   * Arrange to say this again, if it is a level that expires at the far end.
   * Every emit reschedules, so a stream that is talking anyway never sends an
   * extra message, and a value that has gone quiet is renewed on the dot.
   */
  private scheduleKeepAlive(value: T): void {
    this.cancelKeepAlive();
    if (this.keepAliveMs <= 0 || this.stopped || !this.held(value)) return;
    this.keepAliveTimer = this.setTimer(() => {
      this.keepAliveTimer = null;
      // Something newer is already on its way out; it will reschedule.
      if (this.stopped || this.hasQueued || this.timer !== null) return;
      this.emitNow(value);
    }, this.keepAliveMs);
  }

  private cancelKeepAlive(): void {
    if (this.keepAliveTimer === null) return;
    this.clearTimer(this.keepAliveTimer);
    this.keepAliveTimer = null;
  }

  private cancelTimer(): void {
    if (this.timer === null) return;
    this.clearTimer(this.timer);
    this.timer = null;
  }

  private discardQueued(): void {
    this.queued = null;
    this.hasQueued = false;
  }
}

/**
 * The urgency rule shared by the snapshot publisher and the presence updater:
 * a change of `status` jumps the queue. Works for `Snapshot` and for
 * `LobbyPresence`, which both carry a `LaneStatus`.
 */
export function statusChanged<T extends { status: string }>(next: T, lastEmitted: T | null): boolean {
  return lastEmitted === null || next.status !== lastEmitted.status;
}

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Coalescer, statusChanged } from './coalesce';

/**
 * A manual clock driven in step with the fake timers, so "how long has it been"
 * and "which timers have fired" never disagree.
 */
let clock = 0;

function advance(ms: number): void {
  clock += ms;
  vi.advanceTimersByTime(ms);
}

beforeEach(() => {
  vi.useFakeTimers();
  clock = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

interface Tagged {
  id: number;
  status: string;
}

function coalescer(emitted: Tagged[], intervalMs = 80): Coalescer<Tagged> {
  return new Coalescer<Tagged>({
    intervalMs,
    isUrgent: statusChanged,
    now: () => clock,
    emit: (value) => {
      emitted.push(value);
    },
  });
}

describe('Coalescer', () => {
  it('emits the first value immediately', () => {
    const emitted: Tagged[] = [];
    const c = coalescer(emitted);

    c.push({ id: 1, status: 'playing' });

    expect(emitted).toEqual([{ id: 1, status: 'playing' }]);
  });

  it('holds a burst and emits only the newest value when the interval expires', () => {
    const emitted: Tagged[] = [];
    const c = coalescer(emitted);

    c.push({ id: 1, status: 'playing' });
    advance(10);
    c.push({ id: 2, status: 'playing' });
    advance(10);
    c.push({ id: 3, status: 'playing' });
    advance(10);
    c.push({ id: 4, status: 'playing' });

    expect(emitted.map((v) => v.id)).toEqual([1]);
    expect(c.pending).toEqual({ id: 4, status: 'playing' });

    advance(60);

    expect(emitted.map((v) => v.id)).toEqual([1, 4]);
    expect(c.pending).toBeNull();
  });

  it('preserves order across several intervals', () => {
    const emitted: Tagged[] = [];
    const c = coalescer(emitted);

    for (let i = 1; i <= 10; i += 1) {
      c.push({ id: i, status: 'playing' });
      advance(30);
    }
    advance(200);

    const ids = emitted.map((v) => v.id);
    expect(ids[0]).toBe(1);
    expect(ids[ids.length - 1]).toBe(10);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
    expect(ids.length).toBeLessThan(10);
  });

  it('emits a status change immediately and drops the value it superseded', () => {
    const emitted: Tagged[] = [];
    const c = coalescer(emitted);

    c.push({ id: 1, status: 'playing' });
    advance(10);
    c.push({ id: 2, status: 'playing' });
    expect(c.pending).toEqual({ id: 2, status: 'playing' });

    advance(10);
    c.push({ id: 3, status: 'point' });

    expect(emitted.map((v) => v.id)).toEqual([1, 3]);
    expect(c.pending).toBeNull();

    advance(500);

    // id 2 was stale the moment id 3 arrived; it must never appear late.
    expect(emitted.map((v) => v.id)).toEqual([1, 3]);
  });

  it('flush() emits the held value at once', () => {
    const emitted: Tagged[] = [];
    const c = coalescer(emitted);

    c.push({ id: 1, status: 'playing' });
    advance(10);
    c.push({ id: 2, status: 'playing' });
    expect(emitted.map((v) => v.id)).toEqual([1]);

    c.flush();

    expect(emitted.map((v) => v.id)).toEqual([1, 2]);

    advance(500);
    expect(emitted.map((v) => v.id)).toEqual([1, 2]);
  });

  it('flush() with nothing held does nothing', () => {
    const emitted: Tagged[] = [];
    const c = coalescer(emitted);

    c.push({ id: 1, status: 'playing' });
    c.flush();
    c.flush();

    expect(emitted.map((v) => v.id)).toEqual([1]);
  });

  it('stop() drops the held value and ignores later pushes', () => {
    const emitted: Tagged[] = [];
    const c = coalescer(emitted);

    c.push({ id: 1, status: 'playing' });
    advance(10);
    c.push({ id: 2, status: 'playing' });

    c.stop();
    advance(500);
    c.push({ id: 3, status: 'over' });

    expect(emitted.map((v) => v.id)).toEqual([1]);
  });

  it('throttles to one emit per interval at a 1s interval', () => {
    const emitted: Tagged[] = [];
    const c = coalescer(emitted, 1000);

    c.push({ id: 1, status: 'playing' });
    for (let i = 2; i <= 30; i += 1) {
      advance(100);
      c.push({ id: i, status: 'playing' });
    }

    // 2.9s of pushes at a 1s interval: the leading one plus two trailing ones,
    // each carrying the newest value held when its interval expired.
    expect(emitted.map((v) => v.id)).toEqual([1, 10, 20]);
  });
});

/**
 * The paddle-input case, which is what `keepAliveMs` exists for: the worker
 * expires a player's move after INPUT_TTL_MS, so a key that is still down has
 * to keep saying so.
 */
type Move = 'up' | 'down' | 'stay';

function inputCoalescer(
  emitted: Move[],
  { intervalMs = 50, keepAliveMs = 150 }: { intervalMs?: number; keepAliveMs?: number } = {},
): Coalescer<Move> {
  return new Coalescer<Move>({
    intervalMs,
    keepAliveMs,
    isHeld: (move) => move !== 'stay',
    isUrgent: (move, lastEmitted) => move === 'stay' && lastEmitted !== 'stay',
    now: () => clock,
    emit: (move) => {
      emitted.push(move);
    },
  });
}

describe('Coalescer keepalive', () => {
  it('repeats a held value on its own, with nothing pushed', () => {
    const emitted: Move[] = [];
    const c = inputCoalescer(emitted);

    c.push('up');
    expect(emitted).toEqual(['up']);

    advance(150);
    advance(150);
    advance(150);
    expect(emitted).toEqual(['up', 'up', 'up', 'up']);
    c.stop();
  });

  it('renews often enough for a 400 ms expiry, even losing every other message', () => {
    const emitted: Array<{ move: Move; at: number }> = [];
    const c = new Coalescer<Move>({
      intervalMs: 50,
      keepAliveMs: 150,
      isHeld: (move) => move !== 'stay',
      now: () => clock,
      emit: (move) => {
        emitted.push({ move, at: clock });
      },
    });

    c.push('up');
    for (let i = 0; i < 8; i += 1) advance(150);

    // Every other one arriving still leaves a gap of 300 ms, inside the 400 ms
    // the worker keeps an input for.
    const arrived = emitted.filter((_, i) => i % 2 === 0);
    for (let i = 1; i < arrived.length; i += 1) {
      expect(arrived[i].at - arrived[i - 1].at).toBeLessThan(400);
    }
    c.stop();
  });

  it('stops repeating once the key comes up', () => {
    const emitted: Move[] = [];
    const c = inputCoalescer(emitted);

    c.push('up');
    advance(150);
    c.push('stay');
    advance(1000);

    expect(emitted).toEqual(['up', 'up', 'stay']);
    c.stop();
  });

  it('sends the stop at once, without waiting for the rate limit', () => {
    const emitted: Move[] = [];
    const c = inputCoalescer(emitted);

    c.push('up');
    advance(5);
    c.push('stay');

    // Five milliseconds into a 50 ms interval: a queued 'stay' would be a
    // paddle that ran on after the key came up.
    expect(emitted).toEqual(['up', 'stay']);
    c.stop();
  });

  it('starts the window again whenever something is actually sent', () => {
    const emitted: Array<{ move: Move; at: number }> = [];
    const c = new Coalescer<Move>({
      intervalMs: 50,
      keepAliveMs: 150,
      isHeld: (move) => move !== 'stay',
      now: () => clock,
      emit: (move) => {
        emitted.push({ move, at: clock });
      },
    });

    c.push('up');
    advance(100);
    c.push('down');
    advance(150);

    expect(emitted).toEqual([
      { move: 'up', at: 0 },
      { move: 'down', at: 100 },
      { move: 'down', at: 250 },
    ]);
    c.stop();
  });

  it('never overtakes a value already waiting for the interval', () => {
    const emitted: Array<{ move: Move; at: number }> = [];
    const c = new Coalescer<Move>({
      intervalMs: 200,
      keepAliveMs: 150,
      isHeld: (move) => move !== 'stay',
      now: () => clock,
      emit: (move) => {
        emitted.push({ move, at: clock });
      },
    });

    c.push('up');
    advance(100);
    c.push('down'); // held: the interval has 100 ms to run
    advance(50); // 150: the keepalive is due, but 'down' is already waiting
    advance(50); // 200: the interval expires and the newest value goes
    advance(100);

    // 'up' is never re-sent after 'down' was asked for: the repeat would have
    // arrived out of order and driven the paddle back the other way.
    expect(emitted).toEqual([
      { move: 'up', at: 0 },
      { move: 'down', at: 200 },
    ]);

    advance(50); // 350: one keepalive window after the last thing sent
    expect(emitted[emitted.length - 1]).toEqual({ move: 'down', at: 350 });
    c.stop();
  });

  it('stops repeating when the coalescer stops', () => {
    const emitted: Move[] = [];
    const c = inputCoalescer(emitted);

    c.push('up');
    c.stop();
    advance(1000);

    expect(emitted).toEqual(['up']);
  });

  it('says nothing on its own when no keepalive is asked for', () => {
    const emitted: Tagged[] = [];
    const c = coalescer(emitted);

    c.push({ id: 1, status: 'playing' });
    advance(1000);

    expect(emitted.map((v) => v.id)).toEqual([1]);
    c.stop();
  });
});

describe('statusChanged', () => {
  it('treats the first value as a change', () => {
    expect(statusChanged({ status: 'idle' }, null)).toBe(true);
  });

  it('is true only when status differs', () => {
    expect(statusChanged({ status: 'playing' }, { status: 'playing' })).toBe(false);
    expect(statusChanged({ status: 'point' }, { status: 'playing' })).toBe(true);
  });
});

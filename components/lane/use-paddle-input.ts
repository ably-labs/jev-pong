'use client';

/**
 * Human paddle input, decoupled from whoever consumes it.
 *
 * Keyboard: ArrowUp/ArrowDown and W/S. Holding a key repeats the level on every
 * tick rather than firing once, because the worker expires an input it has not
 * heard again (`INPUT_TTL_MS`). Touch/mouse: drag on the court sets a target y
 * and the same tick loop steers towards it.
 *
 * `onMove` is called with 'up' | 'down' | 'stay'. Wire it to a runner's
 * setLeftInput, or to an Ably 'input' publish — this hook does not care which.
 *
 * THE ONE RULE HERE: a 'stay' is never left unsaid. Letting go of a key, moving
 * to another window, hiding the tab and unmounting the page each send one
 * immediately, and the teardown sends it BEFORE the tick interval is cleared.
 * A dropped 'stay' is a paddle stuck against the top of the court for the rest
 * of the game, which is exactly what it looked like the first time this was
 * played.
 */

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { Move } from '@/lib/game/types';

/** How often we repeat the held level. Faster than any model decision. */
export const INPUT_TICK_MS = 40;

/**
 * How close to the pointer counts as "there", in court units. Small, because a
 * human paddle moves continuously on the worker's clock rather than in jumps,
 * so a wide deadband reads as the paddle refusing to follow your finger.
 */
export const POINTER_DEADBAND = 2.5;

export interface PaddleInputOptions {
  onMove: (move: Move) => void;
  /** Current paddle centre in court units, for pointer steering. */
  paddleY: number;
  enabled?: boolean;
}

/** Which keycaps are lit. Changes only when a key goes down or comes up. */
export interface PressedKeys {
  up: boolean;
  down: boolean;
}

export interface PaddleInput {
  /** Pass to <Court onPointerY>. Null on release. */
  setPointerY: (y: number | null) => void;
  /**
   * The direction being asked for right now, as a ref so reading it on every
   * animation frame costs nothing. This is what a locally predicted paddle
   * should be driven from; it is 'stay' whenever input is not accepted.
   */
  held: RefObject<Move>;
  /** For the control cluster. Lit while the key is physically down. */
  pressed: PressedKeys;
}

const NONE: PressedKeys = { up: false, down: false };

export function usePaddleInput({
  onMove,
  paddleY,
  enabled = true,
}: PaddleInputOptions): PaddleInput {
  const heldKeys = useRef<Set<'up' | 'down'>>(new Set());
  const pointerRef = useRef<number | null>(null);
  const paddleRef = useRef(paddleY);
  const onMoveRef = useRef(onMove);
  const enabledRef = useRef(enabled);
  const held = useRef<Move>('stay');
  const [pressed, setPressed] = useState<PressedKeys>(NONE);

  useEffect(() => {
    paddleRef.current = paddleY;
    onMoveRef.current = onMove;
    enabledRef.current = enabled;
  });

  /** What the player is asking for: the keys first, then the pointer. */
  const currentMove = useCallback((): Move => {
    const keys = heldKeys.current;
    if (keys.has('up') && !keys.has('down')) return 'up';
    if (keys.has('down') && !keys.has('up')) return 'down';
    const target = pointerRef.current;
    if (target === null) return 'stay';
    const delta = target - paddleRef.current;
    return Math.abs(delta) <= POINTER_DEADBAND ? 'stay' : delta < 0 ? 'up' : 'down';
  }, []);

  /** Put the current level on the wire, now. */
  const send = useCallback((move: Move) => {
    held.current = enabledRef.current ? move : 'stay';
    if (enabledRef.current) onMoveRef.current(move);
  }, []);

  // Keys, focus and tab visibility. Attached for the life of the hook rather
  // than the life of `enabled`, so the keycaps light up while the game is being
  // dealt and a key let go of in that moment is still let go of.
  useEffect(() => {
    const keys = heldKeys.current;

    const dirFor = (key: string): 'up' | 'down' | null => {
      if (key === 'ArrowUp' || key === 'w' || key === 'W') return 'up';
      if (key === 'ArrowDown' || key === 's' || key === 'S') return 'down';
      return null;
    };

    const show = () => setPressed({ up: keys.has('up'), down: keys.has('down') });

    const onKeyDown = (e: KeyboardEvent) => {
      const dir = dirFor(e.key);
      if (dir === null) return;
      e.preventDefault();
      if (keys.has(dir)) return; // auto-repeat: the level has not changed
      keys.add(dir);
      show();
      send(currentMove());
    };

    const onKeyUp = (e: KeyboardEvent) => {
      const dir = dirFor(e.key);
      if (dir === null) return;
      e.preventDefault();
      keys.delete(dir);
      show();
      // Explicit and immediate: 'stay', unless the other key is still down.
      send(currentMove());
    };

    const letGo = () => {
      keys.clear();
      pointerRef.current = null;
      show();
      send('stay');
    };

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') letGo();
    };

    window.addEventListener('keydown', onKeyDown, { passive: false });
    window.addEventListener('keyup', onKeyUp, { passive: false });
    window.addEventListener('blur', letGo);
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', letGo);
      document.removeEventListener('visibilitychange', onVisibility);
      keys.clear();
      pointerRef.current = null;
      held.current = 'stay';
    };
  }, [currentMove, send]);

  // The tick. It only repeats what the handlers above have already said, so
  // that an input the worker has expired is renewed while a key is still down.
  useEffect(() => {
    if (!enabled) {
      held.current = 'stay';
      return;
    }
    const timer = setInterval(() => send(currentMove()), INPUT_TICK_MS);
    return () => {
      // Before the interval goes, and so before anything downstream of it is
      // torn down: stop the paddle.
      onMoveRef.current('stay');
      held.current = 'stay';
      clearInterval(timer);
    };
  }, [enabled, currentMove, send]);

  const setPointerY = useCallback(
    (y: number | null) => {
      pointerRef.current = y;
      // A release is a stop, and it should not have to wait for the next tick.
      if (y === null) send(currentMove());
    },
    [currentMove, send],
  );

  return { setPointerY, held, pressed };
}

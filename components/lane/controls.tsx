'use client';

/**
 * The controls, said in the shape of the thing you press.
 *
 * Two keycaps beside the court, lit while the key is actually down, so the
 * first thing a player does — press a key and see something happen — happens
 * before the ball has moved at all. On a touch device there are no keys, so the
 * cluster says the true thing there instead: drag the paddle.
 *
 * Which of the two is shown is a `pointer: coarse` media query in
 * app/globals.css, not a render-time guess, so there is nothing to hydrate and
 * nothing to flash.
 */

import type { PressedKeys } from './use-paddle-input';

export interface KeycapProps {
  direction: 'up' | 'down';
  lit: boolean;
}

/**
 * One key. 56px square, which clears the 44px hit target with room, and the
 * cap sits on a 2px bottom edge that it loses when it goes down.
 */
export function Keycap({ direction, lit }: KeycapProps) {
  return (
    <span
      aria-hidden
      className={`keycap ${lit ? 'keycap-lit' : ''}`}
      data-direction={direction}
    >
      <svg width="24" height="24" viewBox="0 0 20 20" className="block">
        {direction === 'up' ? (
          <path
            d="M10 15.5 V5 M4.8 10.2 L10 4.8 L15.2 10.2"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.1"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ) : (
          <path
            d="M10 4.5 V15 M4.8 9.8 L10 15.2 L15.2 9.8"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.1"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}
      </svg>
    </span>
  );
}

/** A hand with a finger out: the touch equivalent of a keycap. */
export function DragIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden className="block">
      <path
        d="M11 15.5V7.6a1.7 1.7 0 0 1 3.4 0v5.2m0-1a1.7 1.7 0 0 1 3.4 0v1m0-.6a1.7 1.7 0 0 1 3.4 0v5.1c0 3.2-2.2 5.4-5.4 5.4h-1.2c-2 0-3.3-.8-4.3-2.3l-3-4.6a1.7 1.7 0 0 1 2.6-2.1l1.1 1.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M22.5 4.5 L25 3.5 M21 2.5 L21.6 0.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        opacity="0.5"
      />
    </svg>
  );
}

/**
 * The cluster that sits to the left of the court: how to move, and proof that
 * the page is listening.
 */
export function PaddleControls({ pressed }: { pressed: PressedKeys }) {
  return (
    <div className="flex flex-col items-center gap-3">
      <p className="sr-only">
        Move your paddle with the up and down arrow keys, with W and S, or by dragging it.
      </p>

      <div className="pointer-fine-only flex flex-row items-center gap-3 lg:flex-col lg:gap-3.5">
        <div className="flex flex-row gap-3 lg:flex-col">
          <Keycap direction="up" lit={pressed.up} />
          <Keycap direction="down" lit={pressed.down} />
        </div>
        <p className="mono text-fg-muted text-[12px] tracking-[0.04em]">or W / S</p>
      </div>

      <div className="pointer-coarse-only text-fg-muted flex-col items-center gap-1.5">
        <DragIcon />
        <p className="max-w-[96px] text-center text-[12px] leading-[1.35]">drag the paddle</p>
      </div>
    </div>
  );
}

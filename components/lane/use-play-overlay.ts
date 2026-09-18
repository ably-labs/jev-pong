'use client';

/**
 * The clock behind the words on the court.
 *
 * `playOverlay` (lib/ui/play-overlay.ts) decides WHAT is written; this decides
 * WHEN, which needs two things the snapshot stream does not carry: how long the
 * lane has been waiting to serve, and how long ago the score changed. Both are
 * measured here, from the moment the browser saw the change.
 *
 * While something is on screen it re-renders on a short interval, because a
 * countdown has to move even when no snapshot arrives. The rest of the time it
 * costs nothing at all.
 */

import { useEffect, useState } from 'react';
import type { Snapshot } from '@/lib/game/types';
import { playOverlay, type PlayOverlay } from '@/lib/ui/play-overlay';

/** Fast enough that "3" never lingers, slow enough to be free. */
const REFRESH_MS = 120;

interface Marks {
  /** When the lane entered `serving`, or null if it is not serving. */
  servingAt: number | null;
  /** When the score last changed. */
  pointAt: number | null;
  pointTo: 'you' | 'them' | null;
}

const NONE: Marks = { servingAt: null, pointAt: null, pointTo: null };

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** What the arrival of `next` does to the marks. */
export function markFor(prev: Snapshot | null, next: Snapshot | null, marks: Marks): Marks {
  if (next === null) return NONE;
  // A lower tick is a new game on the same page: forget the last one's point.
  const restart = prev !== null && next.tick < prev.tick;
  const base = restart ? NONE : marks;

  const serving =
    next.status !== 'serving'
      ? null
      : (!restart && base.servingAt !== null ? base.servingAt : now());

  if (prev !== null && !restart) {
    if (next.score[0] > prev.score[0]) return { servingAt: serving, pointAt: now(), pointTo: 'you' };
    if (next.score[1] > prev.score[1]) {
      return { servingAt: serving, pointAt: now(), pointTo: 'them' };
    }
  }

  return { servingAt: serving, pointAt: base.pointAt, pointTo: base.pointTo };
}

export function usePlayOverlay(
  snapshot: Snapshot | null,
  opponent: string,
  you?: string,
): PlayOverlay {
  const [seen, setSeen] = useState<Snapshot | null>(null);
  const [marks, setMarks] = useState<Marks>(NONE);
  const [, refresh] = useState(0);

  // React's "adjust state when a prop changes" pattern, not an effect: the
  // change is accounted for in the render the snapshot arrives in, so the
  // countdown never starts a frame late.
  if (snapshot !== seen) {
    setSeen(snapshot);
    setMarks(markFor(seen, snapshot, marks));
  }

  const at = now();
  const overlay = playOverlay({
    status: snapshot?.status,
    score: snapshot?.score ?? [0, 0],
    servingForMs: marks.servingAt === null ? null : at - marks.servingAt,
    pointAgeMs: marks.pointAt === null ? null : at - marks.pointAt,
    pointTo: marks.pointTo,
    opponent,
    you,
  });

  const moving = overlay.kind === 'countdown' || overlay.kind === 'point';

  useEffect(() => {
    if (!moving) return;
    const timer = setInterval(() => refresh((n) => (n + 1) % 1000), REFRESH_MS);
    return () => clearInterval(timer);
  }, [moving]);

  return overlay;
}

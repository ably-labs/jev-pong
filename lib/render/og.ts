/**
 * lib/render/og.ts — the numbers on the social card.
 *
 * The card (app/opengraph-image.tsx) is the clip's end card held as a still, so
 * it has to show the clip's numbers. It cannot replay anything, so it counts
 * them the same way the clip does instead: the recorded run is imported at
 * build time and handed to the very function frame.ts calls when it draws the
 * end card, over the same window (the first CLIP_SECONDS of the run).
 *
 * That is the whole point of this module. A hand-copied table of counts drifts
 * the first time the run is re-recorded; this one cannot, because there is only
 * one counter and both surfaces call it.
 */

import replayJson from '../../public/replay.json';
import { CLIP_SECONDS } from '../config/site';
import type { Replay } from '../game/types';
import { endCardRows, type EndCardRow } from './frame';
import { createReplayTimeline } from './timeline';

/** The recorded run: what `/` replays and what the clip is rendered from. */
export const OG_REPLAY = replayJson as unknown as Replay;

/** The window the card measures, in replay time. The clip's play section. */
const OG_FROM_MS = 0;
const OG_TO_MS = CLIP_SECONDS * 1000;

/** One row per lane, in lane order: decisions and returns inside the window. */
export function ogRows(replay: Replay = OG_REPLAY): EndCardRow[] {
  return endCardRows(replay, createReplayTimeline(replay).lanes, OG_FROM_MS, OG_TO_MS);
}

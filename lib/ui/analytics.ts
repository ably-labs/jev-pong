/**
 * lib/ui/analytics.ts — what the site counts.
 *
 * Vercel Web Analytics, which is cookieless and needs no consent banner. Page
 * views, referrers, countries and devices come from the <Analytics /> component
 * in app/layout.tsx. These four events are the funnel on top of that, and they
 * are the only custom data the site sends:
 *
 *   game_started   a game was dealt on /play
 *   game_over      it finished: won or lost, why it ended, and the score
 *   watch_opened   somebody opened a /watch link
 *   share_copied   a player copied their watch link
 *
 * Nothing a person typed travels with them: no names, no game ids, no client
 * ids. Every call site is a browser effect or a click handler.
 */

import { track } from '@vercel/analytics';

export type GameResult = 'won' | 'lost';

export function trackGameStarted(): void {
  track('game_started');
}

export function trackGameOver(outcome: { result: GameResult; reason: string; score: string }): void {
  track('game_over', outcome);
}

export function trackWatchOpened(): void {
  track('watch_opened');
}

export function trackShareCopied(): void {
  track('share_copied');
}

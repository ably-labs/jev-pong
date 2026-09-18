'use client';

/**
 * Spectator. One game, streamed off `pong:game:<id>`.
 *
 * A viewer is a member of the channel, not an anonymous reader: it enters
 * presence as `{ role: 'spectator' }`, which is where the "N watching" number
 * comes from — here and on the player's page. It is also what keeps a demo game
 * alive; the worker stops one that nobody is watching. Nobody watching is a
 * real state, so the count and its dots are absent rather than showing a zero.
 *
 * The layout is /play's cabinet with nobody's hands on it: score over a wide
 * court, model and latency to the right. It used to be a 440px phone column at
 * every width, which on a laptop read as a page that had failed to load.
 *
 * A watch link can point at any game, not only a game against Jev — the arena
 * runs one per model — so the lane's name, provider tag and colour come from
 * whichever model the game says it is running.
 */

import { useEffect, type ReactNode } from 'react';
import { ChannelCard, MemberDots } from './channel-card';
import { LiveDot, PendingDot, SiteFooter, SiteHeader } from './chrome';
import { Court } from './court';
import { LaneNumber } from './number';
import { Scoreboard } from './scoreboard';
import { useLaneNumbers } from './use-lane';
import { AblyClientProvider } from '@/components/ably/provider';
import { anonForGame, channelLabel, displayName, useGameFeed } from '@/lib/ably/feed';
import { useGamePresence, useSpectateGame, useSpectatorPresence } from '@/lib/ably/hooks';
import { trackWatchOpened } from '@/lib/ui/analytics';
import { LANES, type LaneConfig } from '@/lib/game/types';
import { CLIP_TOKENS, providerFor } from '@/lib/render/tokens';
import { watchStatus, type WatchStatus } from '@/lib/ui/play-status';

const JEV = LANES.find((lane) => lane.id === 'jev') ?? LANES[0];

/**
 * The lane a game is being played by. The snapshot is the authority once one
 * has arrived; before that the agent's own presence entry is all there is. A
 * model this build does not know about falls back to Jev, which is what /play
 * always is.
 */
function laneFor(model: string | undefined): LaneConfig {
  return LANES.find((lane) => lane.id === model) ?? JEV;
}

function Frame({ badge, children }: { badge?: ReactNode; children: ReactNode }) {
  return (
    <>
      <SiteHeader right={badge} />
      {children}
    </>
  );
}

export function Watch({ gameId }: { gameId: string }) {
  return (
    <main className="mx-auto flex w-full max-w-[1280px] flex-1 flex-col px-4 pb-6 lg:px-10">
      <AblyClientProvider
        fallback={
          <Frame badge={<StateBadge status={{ tone: 'connecting', label: 'Connecting…' }} />}>
            <WatchStage snapshot={null} lane={JEV} player={anonForGame(gameId)} viewers={0} />
          </Frame>
        }
      >
        <WatchStream gameId={gameId} />
      </AblyClientProvider>

      <div className="grow" />
      <div className="pt-10 lg:pt-14">
        <SiteFooter />
      </div>
    </main>
  );
}

function WatchStream({ gameId }: { gameId: string }) {
  useSpectatorPresence(gameId);
  useEffect(() => trackWatchOpened(), [gameId]);

  const { snapshot, state, arrivedAtMs } = useSpectateGame(gameId);
  const { agentPresent, agentModel, viewers, players } = useGamePresence(gameId);
  const lines = useGameFeed(gameId);

  // The snapshot is the authority on which model is playing; before the first
  // one arrives the agent's presence entry is all there is.
  const lane = laneFor(snapshot?.model ?? agentModel);
  const opponent = lane.label;
  // Whoever is on the left paddle calls themselves what they typed on /play. If
  // nobody is present yet, the game is named after its own channel.
  const seat = players[0];
  const player = seat ? displayName(seat.clientId, seat.name) : anonForGame(gameId);
  const status = watchStatus(state, snapshot, opponent, player);

  const here = [agentPresent ? opponent : null, players.length > 0 ? player : null].filter(
    (part): part is string => part !== null,
  );
  const summary = [
    here.length > 0 ? `${here.join(' and ')} on the channel` : 'no players yet',
    viewers > 0 ? `${viewers} watching` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(' · ');

  return (
    <Frame badge={<StateBadge status={status} />}>
      <h1 className="sr-only">
        {player} vs {opponent}
      </h1>

      <WatchStage
        snapshot={snapshot}
        arrivedAtMs={arrivedAtMs}
        lane={lane}
        player={player}
        viewers={viewers}
        live={status.tone === 'live'}
      />

      <div className="pt-5 lg:pt-7">
        <ChannelCard label={channelLabel(gameId)} lines={lines} summary={summary} />
      </div>
    </Frame>
  );
}

function WatchStage({
  snapshot,
  lane,
  player,
  viewers,
  live = false,
  arrivedAtMs,
}: {
  snapshot: Parameters<typeof useLaneNumbers>[0];
  lane: LaneConfig;
  player: string;
  viewers: number;
  live?: boolean;
  arrivedAtMs?: number;
}) {
  const numbers = useLaneNumbers(snapshot);
  const score = snapshot?.score ?? [0, 0];

  return (
    <section className="watch-stage pt-4 lg:pt-6">
      <div className="flex w-full flex-col items-center gap-3 lg:gap-4">
        <Scoreboard
          size="watch"
          you={{ name: player, score: score[0] }}
          them={{ name: lane.label, score: score[1] }}
        />
        <div className="court-arcade w-full">
          <Court arrivedAtMs={arrivedAtMs}
            snapshot={snapshot}
            model={lane.id}
            surface="play"
            className="court-arcade"
            showScore={false}
            ariaLabel={`${player} versus ${lane.label}, score ${score[0]} to ${score[1]}`}
          />
        </div>
      </div>

      <div className="flex w-full flex-row items-end justify-between gap-4 sm:w-auto sm:flex-col sm:items-end sm:gap-3">
        <div className="flex flex-col gap-[3px] sm:items-end sm:gap-1">
          <h2 className="text-[16px] leading-[1.1] font-semibold lg:text-[18px]">{lane.label}</h2>
          <p className="tag">{providerFor(CLIP_TOKENS, lane.gateway)}</p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <LaneNumber
            model={lane.id}
            numbers={numbers}
            scale="watch"
            live={live}
            thinkingLabel={live ? `${lane.label} is thinking` : undefined}
          />
          {viewers > 0 && (
            <span className="flex items-center gap-1.5">
              <MemberDots count={viewers} size={6} />
              <span className="text-fg-muted pl-0.5 text-[12px] lg:text-[13px]">
                {viewers} watching
              </span>
            </span>
          )}
        </div>
      </div>
    </section>
  );
}

/** Motion note 06: the live dot breathes; every state is a fade, never a jump. */
function StateBadge({ status }: { status: WatchStatus }) {
  if (status.tone === 'connecting') {
    return (
      <span className="text-fg-muted flex items-center gap-[7px] text-[12px] font-semibold">
        <PendingDot />
        {status.label}
      </span>
    );
  }
  if (status.tone === 'ended') {
    return <span className="text-fg-muted text-[12px] font-semibold">{status.label}</span>;
  }
  return (
    <span className="flex items-center gap-[7px] text-[12px] font-semibold">
      <LiveDot breathing />
      {status.label}
    </span>
  );
}

export default Watch;

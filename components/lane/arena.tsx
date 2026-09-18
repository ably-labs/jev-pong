'use client';

/**
 * The live arena: one demo game per model, running at the same time.
 *
 * Nothing here simulates anything. "Start arena" asks `POST /api/game` for four
 * games — `{ mode: 'demo', model }` per lane — and then the page is four
 * spectators, each following its own `pong:game:<id>` channel. The difference
 * between the lanes is entirely the model's decision latency, which is the only
 * claim this demo makes.
 *
 * It is gated (see lib/config/admin.ts): four workers calling four models for
 * up to thirteen minutes is not something a stranger should be able to start.
 */

import { useCallback, useEffect, useState } from 'react';
import { AblyClientProvider } from '@/components/ably/provider';
import { useGamePresence, useSpectateGame, useSpectatorPresence } from '@/lib/ably/hooks';
import { storeAdminToken } from '@/lib/config/admin';
import { LANES, type LaneConfig } from '@/lib/game/types';
import { startGame } from '@/lib/ui/start-game';
import { LiveDot, PendingDot, SiteFooter, SiteHeader, StatusBadge } from './chrome';
import { Lane } from './lane';

export interface ArenaProps {
  /** Did `isAdminRequest` pass? Decided on the server, never here. */
  allowed: boolean;
  /** Hide everything except the lanes, for screen recording. */
  clean: boolean;
  /** An admin token from the URL, remembered so the next visit needs no link. */
  token: string | null;
}

interface ArenaGame {
  config: LaneConfig;
  gameId: string;
}

type ArenaPhase = 'idle' | 'starting' | 'running';

export function Arena({ allowed, clean, token }: ArenaProps) {
  const [phase, setPhase] = useState<ArenaPhase>('idle');
  const [games, setGames] = useState<ArenaGame[]>([]);
  const [failed, setFailed] = useState<string[]>([]);

  // A token that arrived in the link is kept, so the arena link on the home
  // page can appear at all on the next visit.
  useEffect(() => {
    if (token !== null && token !== '') storeAdminToken(token);
  }, [token]);

  const start = useCallback(() => {
    setPhase('starting');
    setFailed([]);
    void Promise.all(
      LANES.map(async (config) => ({
        config,
        result: await startGame({ mode: 'demo', model: config.id }),
      })),
    ).then((outcomes) => {
      const started: ArenaGame[] = [];
      const refused: string[] = [];
      for (const { config, result } of outcomes) {
        if (result.ok) started.push({ config, gameId: result.gameId });
        else refused.push(`${config.label}: ${result.error.replace(/_/g, ' ')}`);
      }
      setGames(started);
      setFailed(refused);
      setPhase('running');
    });
  }, []);

  if (!allowed) {
    return (
      <main className="mx-auto w-full max-w-[1280px] px-4 pb-6 lg:px-20">
        <SiteHeader right={<span className="text-fg-muted text-[13px]">arena</span>} />
        <h1 className="pt-8 text-[40px] leading-[1.05] font-bold tracking-[-0.03em] lg:text-[64px]">
          Arena
        </h1>
        <p className="text-fg-muted max-w-[680px] pt-4 text-[17px] leading-[1.45] lg:text-[22px]">
          The arena is off in production. It starts four live games at once, so it needs an
          admin token. The front page plays a recording of the same four lanes.
        </p>
        <div className="pt-10 lg:pt-14">
          <SiteFooter />
        </div>
      </main>
    );
  }

  const stack = (
    <div className="flex flex-col gap-3.5 lg:gap-2.5">
      {games.map((game) => (
        <ArenaLane key={game.gameId} config={game.config} gameId={game.gameId} />
      ))}
    </div>
  );

  // Recording mode: the lanes and nothing else.
  if (clean) {
    return (
      <main className="mx-auto flex w-full max-w-[1280px] flex-1 flex-col justify-center px-4 py-6 lg:px-20">
        {games.length === 0 ? (
          <StartButton phase={phase} onClick={start} />
        ) : (
          <AblyClientProvider>{stack}</AblyClientProvider>
        )}
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-[1280px] px-4 pb-6 lg:px-20">
      <SiteHeader
        right={
          <span className="text-fg-muted text-[12px] lg:text-[13px]">
            {games.length === 0 ? 'idle' : `${games.length} live`}
          </span>
        }
      />

      <div className="flex flex-col gap-2.5 pt-5 lg:gap-4 lg:pt-12">
        <h1 className="text-[40px] leading-[1.05] font-bold tracking-[-0.03em] lg:text-[64px]">
          Arena
        </h1>
        <p className="text-fg-muted max-w-[680px] text-[17px] leading-[1.45] lg:text-[22px] lg:leading-[1.4]">
          One game per model, all four at once, every ball step a real decision. Same rally,
          same rules, different model.
        </p>
      </div>

      <div className="pt-6 lg:pt-8">
        <StartButton phase={phase} onClick={start} />
      </div>

      {failed.length > 0 && (
        <ul className="flex flex-col gap-1 pt-4">
          {failed.map((line) => (
            <li key={line} className="text-fg-muted text-[13px]">
              {line}
            </li>
          ))}
        </ul>
      )}

      <section aria-label="Model lanes" className="pt-8 lg:pt-10">
        {games.length === 0 ? (
          <p className="text-fg-muted border-hair border-t py-4 text-[13px]">
            nothing running · press start
          </p>
        ) : (
          <AblyClientProvider
            fallback={
              <p className="text-fg-muted border-hair border-t py-4 text-[13px]">connecting…</p>
            }
          >
            {stack}
          </AblyClientProvider>
        )}
      </section>

      <div className="pt-10 lg:pt-14">
        <SiteFooter />
      </div>
    </main>
  );
}

function StartButton({ phase, onClick }: { phase: ArenaPhase; onClick: () => void }) {
  const label =
    phase === 'starting' ? 'Starting…' : phase === 'running' ? 'Restart arena' : 'Start arena';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={phase === 'starting'}
      className="bg-fg text-btn-fg rounded-control h-12 px-[22px] text-[16px] font-semibold disabled:opacity-60"
    >
      {label}
    </button>
  );
}

/**
 * One lane of the arena: a spectator of one game.
 *
 * It enters presence as a viewer, which is both how the count on the row is
 * earned and how the worker knows somebody is still looking — a demo nobody
 * watches is stopped rather than left to burn credits.
 */
function ArenaLane({ config, gameId }: { config: LaneConfig; gameId: string }) {
  useSpectatorPresence(gameId);
  const { snapshot } = useSpectateGame(gameId);
  const { agentPresent, viewers } = useGamePresence(gameId);

  return (
    <Lane
      config={config}
      snapshot={snapshot}
      surface="home"
      badge={
        <StatusBadge show className="text-fg-muted font-normal">
          {agentPresent ? <LiveDot size={6} /> : <PendingDot size={6} />}
          {agentPresent ? `${viewers} watching` : 'waiting'}
        </StatusBadge>
      }
    />
  );
}

export default Arena;

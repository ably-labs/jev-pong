'use client';

/**
 * Play against Jev.
 *
 * This page runs no game. It asks `POST /api/game` for one, and from then on it
 * is an ordinary member of `pong:game:<id>`, exactly like a spectator with a
 * paddle:
 *
 *   out   presence `{ role: 'player', name }`, then `input` messages `{ move }`
 *   in    `state` messages carrying a Snapshot, and the presence set
 *
 * It renders from the snapshots on the wire, not from a local simulation, so
 * what the player sees is what everyone on /watch/<id> sees. That is the whole
 * point of the Ably-native design: there is one game, in one place, and the
 * browser is not it.
 *
 * The layout is a cabinet. The court is the biggest thing on the page, the
 * score sits above its centre, the controls are on the left where your hand is,
 * and Jev's latency is on the right where the claim is. Everything that is
 * about the plumbing rather than the game — the channel, the watch link — is
 * below the fold of the court.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from 'react';
import { AblyClientProvider } from '@/components/ably/provider';
import { channelLabel, displayName, useGameFeed, useSelfClientId } from '@/lib/ably/feed';
import { useGamePresence, usePlayerInput, useSpectateGame } from '@/lib/ably/hooks';
import { COURT_H, LANES, type Move, type Snapshot } from '@/lib/game/types';
import { CLIP_TOKENS, providerFor } from '@/lib/render/tokens';
import { NAME_MAX } from '@/lib/ui/name';
import { playStatus, type DealErrorCode, type DealPhase, type PlayStatus } from '@/lib/ui/play-status';
import { startGame, type StartGameResult } from '@/lib/ui/start-game';
import { trackGameOver, trackGameStarted, trackShareCopied } from '@/lib/ui/analytics';
import { ChannelCard } from './channel-card';
import {
  LiveDot,
  PendingDot,
  PrimaryButton,
  SecondaryButton,
  SiteFooter,
  SiteHeader,
} from './chrome';
import { PaddleControls } from './controls';
import { Court } from './court';
import { LaneNumber } from './number';
import { Scoreboard } from './scoreboard';
import { useLaneNumbers } from './use-lane';
import { usePaddleInput, type PressedKeys } from './use-paddle-input';
import { usePlayOverlay } from './use-play-overlay';
import { useStoredName } from './use-stored-name';

const JEV = LANES.find((lane) => lane.id === 'jev') ?? LANES[0];
const NO_KEYS: PressedKeys = { up: false, down: false };

interface Deal {
  /** Which press of "Play again" this belongs to. */
  attempt: number;
  phase: DealPhase;
  gameId: string | null;
  error: DealErrorCode | null;
}

const DEALING: Deal = { attempt: 0, phase: 'dealing', gameId: null, error: null };

export function Play() {
  const [attempt, setAttempt] = useState(0);
  const [deal, setDeal] = useState<Deal>(DEALING);

  // The name is asked once per browser, and before a game is dealt — so the
  // worker is not sitting on a clock while somebody types.
  const [name, answer] = useStoredName();
  const named = typeof name === 'string';

  // One POST per attempt, however many times the effect runs.
  //
  // React StrictMode mounts, tears down and mounts again in development. A
  // second POST would start a second worker — a real game, burning real model
  // credits, that nobody would ever join. The ref survives the remount (it is
  // the same component instance), so the second run adopts the request the
  // first one made instead of making its own.
  const pending = useRef<{ attempt: number; result: Promise<StartGameResult> } | null>(null);

  useEffect(() => {
    if (!named) return;
    let live = true;
    const current = pending.current;
    const result =
      current !== null && current.attempt === attempt
        ? current.result
        : startGame({ mode: 'vs-jev', model: 'jev' });
    pending.current = { attempt, result };

    void result.then((outcome) => {
      if (!live) return;
      if (outcome.ok) trackGameStarted();
      setDeal(
        outcome.ok
          ? { attempt, phase: 'ready', gameId: outcome.gameId, error: null }
          : { attempt, phase: 'failed', gameId: null, error: outcome.error },
      );
    });

    return () => {
      live = false;
    };
  }, [attempt, named]);

  // Bumping the attempt is the whole of "play again": the deal below is keyed by
  // attempt, so last game's outcome stops being the current one in the same
  // render, with no second setState to get out of step with a double click.
  const again = useCallback(() => setAttempt((n) => n + 1), []);

  // A deal from a previous attempt is stale; show "dealing" rather than the
  // last game's outcome.
  const current: Deal = deal.attempt === attempt ? deal : { ...DEALING, attempt };

  return (
    <AblyClientProvider fallback={<Shell />}>
      <PlayShell deal={current} name={name} onName={answer} onAgain={again} />
    </AblyClientProvider>
  );
}

/**
 * The page frame with an empty court, rendered on its own while the browser
 * Ably client is being built (SSR and the first paint).
 */
function Shell() {
  return (
    <Frame badge={<Badge tone="waiting" label="connecting" />}>
      <PlayStage snapshot={null} you="you" />
    </Frame>
  );
}

function Frame({ badge, children }: { badge?: ReactNode; children: ReactNode }) {
  return (
    <main className="mx-auto w-full max-w-[1280px] px-4 pb-6 lg:px-10">
      <SiteHeader right={badge} />
      {children}
      <div className="pt-10 lg:pt-14">
        <SiteFooter />
      </div>
    </main>
  );
}

function PlayShell({
  deal,
  name,
  onName,
  onAgain,
}: {
  deal: Deal;
  name: string | null | undefined;
  onName: (value: string) => void;
  onAgain: () => void;
}) {
  const clientId = useSelfClientId();
  const gameId = deal.gameId;
  const you = displayName(clientId, name);

  // Never asked: the court waits behind the question rather than starting
  // without the player.
  if (name === null) {
    return (
      <Frame>
        <PlayStage snapshot={null} you="you" overlay={<NamePrompt onName={onName} />} />
      </Frame>
    );
  }

  if (gameId === null) {
    return <OfflineSurface deal={deal} onAgain={onAgain} you={you} />;
  }

  return (
    <PlaySurface
      key={gameId}
      gameId={gameId}
      you={you}
      name={name ?? null}
      onAgain={onAgain}
    />
  );
}

/** What there is to show before — or instead of — a game channel. */
function OfflineSurface({
  deal,
  onAgain,
  you,
}: {
  deal: Deal;
  onAgain: () => void;
  you: string;
}) {
  const status = playStatus({
    deal: deal.phase,
    dealError: deal.error,
    connection: 'connecting',
    snapshot: null,
    agentPresent: false,
    opponent: JEV.label,
  });

  return (
    <Frame badge={<Badge tone={status.tone} label={status.label} />}>
      <PlayStage
        snapshot={null}
        you={you}
        overlay={
          status.offerRestart ? (
            <EndCard title={status.label} detail={status.detail} onAgain={onAgain} />
          ) : null
        }
      />
    </Frame>
  );
}

function PlaySurface({
  gameId,
  you,
  name,
  onAgain,
}: {
  gameId: string;
  you: string;
  name: string | null;
  onAgain: () => void;
}) {
  const { snapshot, state, arrivedAtMs } = useSpectateGame(gameId);
  const { agentPresent, viewers, players } = useGamePresence(gameId);
  const lines = useGameFeed(gameId);

  const status = playStatus({
    deal: 'ready',
    dealError: null,
    connection: state,
    snapshot,
    agentPresent,
    opponent: JEV.label,
  });

  // The input hook is mounted BEFORE the publisher, so on unmount its cleanup —
  // the final 'stay' — runs before the publisher flushes and lets go of the
  // channel. React tears effects down in the order they were set up.
  //
  // `held` is the direction being asked for on this frame ('stay' whenever
  // input is not accepted). The court draws the player's paddle from it — see
  // lib/ui/paddle.ts — so the paddle answers the key now rather than in a round
  // trip, while the worker stays the authority on where it really is.
  const sendRef = useRef<(move: Move) => void>(() => {});
  const { setPointerY, held, pressed } = usePaddleInput({
    onMove: (move) => sendRef.current(move),
    paddleY: snapshot?.leftY ?? COURT_H / 2,
    enabled: status.acceptInput,
  });
  const { sendInput, sentSeq } = usePlayerInput(gameId, name);
  useEffect(() => {
    sendRef.current = sendInput;
  }, [sendInput]);

  const overlay = usePlayOverlay(snapshot, JEV.label, you);

  // One analytics event per finished game: the result, why it ended, the score.
  const reported = useRef<string | null>(null);
  useEffect(() => {
    if (overlay.kind !== 'over' || snapshot === null || reported.current === gameId) return;
    reported.current = gameId;
    trackGameOver({
      result: snapshot.score[0] > snapshot.score[1] ? 'won' : 'lost',
      reason: snapshot.message ?? 'over',
      score: `${snapshot.score[0]}-${snapshot.score[1]}`,
    });
  }, [overlay.kind, snapshot, gameId]);

  // "Jev and Matt on the channel · 1 watching". Names, not roles: the point of
  // the line is that the agent is a member here exactly like the human is.
  const here = [agentPresent ? JEV.label : null, players.length > 0 ? you : null].filter(
    (part): part is string => part !== null,
  );
  const summary = [
    here.length > 0 ? `${here.join(' and ')} on the channel` : 'no players yet',
    viewers > 0 ? `${viewers} watching` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(' · ');

  // The scoreline is the headline, so the sentence under it never repeats it.
  const ended =
    overlay.kind === 'over'
      ? { title: overlay.title, detail: snapshot?.message === 'won' ? null : status.detail }
      : status.offerRestart
        ? { title: status.label, detail: status.detail }
        : null;

  return (
    <Frame badge={<Badge tone={status.tone} label={status.label} />}>
      <PlayStage
        snapshot={snapshot}
        arrivedAtMs={arrivedAtMs}
        you={you}
        pressed={pressed}
        held={held}
        sentSeq={sentSeq}
        live
        onPointerY={status.acceptInput ? setPointerY : undefined}
        overlay={
          ended !== null ? (
            <EndCard
              title={ended.title}
              detail={ended.detail}
              onAgain={onAgain}
              gameId={gameId}
            />
          ) : overlay.kind === 'countdown' ? (
            <Countdown count={overlay.count} title={overlay.title} hint={overlay.hint} />
          ) : overlay.kind === 'point' ? (
            <PointFlash title={overlay.title} />
          ) : null
        }
      />

      <div className="flex flex-col gap-3 pt-7 lg:pt-9">
        <ChannelCard label={channelLabel(gameId)} lines={lines} summary={summary} />
        <WatchLink gameId={gameId} />
      </div>
    </Frame>
  );
}

/* ------------------------------------------------------------------ the stage */

/** Controls, court and model: the three things a player looks at, in that order. */
function PlayStage({
  snapshot,
  you,
  pressed = NO_KEYS,
  held,
  sentSeq,
  live = false,
  onPointerY,
  overlay,
  arrivedAtMs,
}: {
  snapshot: Snapshot | null;
  you: string;
  pressed?: PressedKeys;
  /** The direction being asked for right now. Drives the predicted paddle. */
  held?: RefObject<Move>;
  /** The newest input seq sent, so the court knows when the wire has caught up. */
  sentSeq?: RefObject<number>;
  /** There is a game on the channel, so silence on it means something. */
  live?: boolean;
  onPointerY?: (y: number | null) => void;
  overlay?: ReactNode;
  arrivedAtMs?: number;
}) {
  const numbers = useLaneNumbers(snapshot);
  const score = snapshot?.score ?? [0, 0];

  return (
    <section className="play-stage pt-4 lg:pt-6">
      <div className="order-2 lg:order-none">
        <PaddleControls pressed={pressed} />
      </div>

      <div className="order-1 flex w-full flex-col items-center gap-3 lg:order-none lg:gap-4">
        {/* The scoreline above the court is the score. The canvas draws its own
            small one on surfaces that have no room for this (see COURT_SIZES in
            lib/render/court.ts); here it would be the same number twice. */}
        <Scoreboard you={{ name: you, score: score[0] }} them={{ name: JEV.label, score: score[1] }} />
        <div className="court-arcade relative mx-auto w-full">
          <Court arrivedAtMs={arrivedAtMs}
            snapshot={snapshot}
            model="human"
            surface="play"
            className="court-arcade"
            humanSide="left"
            held={held}
            sentSeq={sentSeq}
            showScore={false}
            onPointerY={onPointerY}
            ariaLabel={`Your game against ${JEV.label}, score ${score[0]} to ${score[1]}`}
          />
          {overlay}
        </div>
      </div>

      <div className="order-3 flex w-full flex-row items-end justify-between gap-4 lg:order-none lg:w-auto lg:flex-col lg:items-end lg:gap-3">
        <div className="flex flex-col gap-[3px] lg:items-end lg:gap-1">
          <h2 className="text-[17px] leading-[1.1] font-semibold lg:text-[20px]">{JEV.label}</h2>
          <p className="tag">{providerFor(CLIP_TOKENS, JEV.gateway)}</p>
        </div>
        <LaneNumber
          model={JEV.id}
          numbers={numbers}
          scale="play"
          live={live}
          thinkingLabel={live ? `${JEV.label} is thinking` : undefined}
        />
      </div>
    </section>
  );
}

/* --------------------------------------------------------------- the overlays */

/**
 * Every overlay sits in the same place: dead centre of the court.
 *
 * `scrim` dims the court behind it; `card` puts the content on a surface of its
 * own, for the two states that are a thing to read and answer rather than a
 * thing to glance at. On a phone the court is only ~150px tall, so a card is
 * allowed to stand slightly proud of it — that reads as a panel over the game,
 * where content spilling out of a dimmed rectangle would read as a bug.
 */
function Overlay({
  children,
  scrim = true,
  card = false,
  pop = false,
}: {
  children: ReactNode;
  scrim?: boolean;
  card?: boolean;
  /** Arrive with a small scale as well as a fade. The point flash only. */
  pop?: boolean;
}) {
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-3">
      {scrim && <div aria-hidden className="bg-court absolute inset-0 rounded-[8px] opacity-[0.88]" />}
      <div
        className={`${pop ? 'overlay-pop' : 'overlay-in'} pointer-events-auto relative flex flex-col items-center gap-2.5 text-center lg:gap-3 ${
          card ? 'bg-surface border-hair rounded-card border px-5 py-4' : ''
        }`}
      >
        {children}
      </div>
    </div>
  );
}

function Countdown({ count, title, hint }: { count: number; title: string; hint: string }) {
  return (
    <Overlay>
      <p className="text-[15px] font-semibold lg:text-[18px]">{title}</p>
      {/* Re-keyed so each number arrives on its own, rather than morphing. */}
      <p
        key={count}
        className="overlay-in mono text-fg text-[44px] leading-none font-medium tracking-[-0.02em] lg:text-[80px]"
      >
        {count}
      </p>
      <p className="text-fg-muted text-[12px] lg:text-[13px]">{hint}</p>
    </Overlay>
  );
}

/**
 * A point. It arrives with a small pop and leaves on its own after a second and
 * a half; the court is not dimmed, because the serve for the next point is
 * already being set up behind it.
 */
function PointFlash({ title }: { title: string }) {
  return (
    <Overlay scrim={false} pop>
      <p className="bg-court/92 border-hair rounded-card border px-5 py-2.5 text-[22px] font-bold tracking-[-0.02em] lg:text-[30px]">
        {title}
      </p>
    </Overlay>
  );
}

function EndCard({
  title,
  detail,
  onAgain,
  gameId,
}: {
  title: string;
  detail: string | null;
  onAgain: () => void;
  gameId?: string;
}) {
  return (
    <Overlay card>
      <p className="text-[26px] font-bold tracking-[-0.02em] lg:text-[36px]">{title}</p>
      {detail !== null && (
        <p className="text-fg-muted max-w-[420px] text-[13px] leading-[1.5]">{detail}</p>
      )}
      <div className="flex flex-col items-center gap-2 pt-1 sm:flex-row sm:gap-3">
        <PrimaryButton onClick={onAgain}>Play again</PrimaryButton>
        {gameId !== undefined && <CopyWatchLink gameId={gameId} />}
      </div>
      {gameId !== undefined && <WatchHint gameId={gameId} />}
    </Overlay>
  );
}

/** The share link as text, so it is readable and not only copyable. */
function WatchHint({ gameId }: { gameId: string }) {
  const href = useWatchHref(gameId);
  if (href === `/watch/${gameId}`) return null;
  return (
    <p className="text-fg-muted mono max-w-[420px] truncate text-[11.5px] lg:text-[12px]">{href}</p>
  );
}

/* ---------------------------------------------------------------- the name */

function NamePrompt({ onName }: { onName: (value: string) => void }) {
  const [value, setValue] = useState('');
  return (
    <Overlay card>
      <form
        className="flex flex-col items-center gap-2.5"
        onSubmit={(e) => {
          e.preventDefault();
          onName(value);
        }}
      >
        <label htmlFor="player-name" className="text-[15px] font-semibold lg:text-[18px]">
          Your name
        </label>
        <div className="flex items-center gap-2 sm:gap-3">
          <input
            id="player-name"
            name="name"
            type="text"
            autoComplete="nickname"
            maxLength={NAME_MAX}
            placeholder="anon"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="border-btn-border bg-surface text-fg rounded-control h-12 w-[150px] px-3.5 text-[16px] sm:w-[200px]"
          />
          <PrimaryButton type="submit">Start</PrimaryButton>
        </div>
        <p className="text-fg-muted max-w-[300px] text-[12px] leading-[1.45] lg:text-[13px]">
          Optional. It shows on the channel and to anyone watching your game.
        </p>
      </form>
    </Overlay>
  );
}

/* ------------------------------------------------------------- the badge */

function Badge({ tone, label }: { tone: PlayStatus['tone']; label: string }) {
  return (
    <span className="text-fg-muted flex items-center gap-[7px] text-[12px] font-semibold">
      {tone === 'live' ? <LiveDot breathing /> : tone === 'waiting' ? <PendingDot /> : null}
      {label}
    </span>
  );
}

/* --------------------------------------------------------- the watch link */

/**
 * The page's own origin. It is an external fact that never changes while the
 * page is open, so it is read as one — the server snapshot is empty, which is
 * what the server markup renders, and the real origin appears on hydration
 * rather than mismatching it.
 */
const NEVER_CHANGES = () => () => {};
const READ_ORIGIN = () => window.location.origin;
const NO_ORIGIN = () => '';

function useWatchHref(gameId: string): string {
  const origin = useSyncExternalStore(NEVER_CHANGES, READ_ORIGIN, NO_ORIGIN);
  return `${origin}/watch/${gameId}`;
}

function useCopy(href: string): { copied: boolean; copy: () => void } {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(() => {
    void navigator.clipboard
      ?.writeText(href)
      .then(() => {
        setCopied(true);
        trackShareCopied();
      })
      .catch(() => setCopied(false));
  }, [href]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);

  return { copied, copy };
}

function CopyWatchLink({ gameId }: { gameId: string }) {
  const { copied, copy } = useCopy(useWatchHref(gameId));
  return <SecondaryButton onClick={copy}>{copied ? 'Link copied' : 'Watch link'}</SecondaryButton>;
}

function WatchLink({ gameId }: { gameId: string }) {
  const href = useWatchHref(gameId);
  const { copied, copy } = useCopy(href);

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
      <label htmlFor="watchlink" className="text-fg-muted text-[13px]">
        Watch link
      </label>
      <input
        id="watchlink"
        type="text"
        readOnly
        value={href}
        className="mono border-btn-border bg-surface text-fg rounded-control h-10 w-full px-3 text-[13px] sm:w-[360px]"
      />
      <button
        type="button"
        onClick={copy}
        className="border-btn-border bg-surface text-fg rounded-control h-10 shrink-0 self-start px-4 text-[14px] font-medium sm:self-auto"
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

export default Play;

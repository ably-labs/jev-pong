'use client';

/**
 * The front page. The claim, then the lanes, then the numbers behind both.
 *
 * Order matters more than anything else here. Somebody arriving from Hacker
 * News or X has about a second: the four courts have to be moving in it, so
 * they sit directly under a one-line headline and everything that explains them
 * comes after. The headline, the strip and the social card all read their
 * figures from public/replay-stats.json and the recording itself (lib/ui/stats.ts,
 * lib/render/og.ts) at build time, so no number on this page was typed by hand.
 *
 * It replays public/replay.json — a recording of a real run, played back
 * through the same renderer the live pages use. It costs nothing, it is
 * identical on every machine, and it is therefore what everyone sees.
 *
 * The four lanes are four independent runners, and the recordings do not end on
 * the same millisecond, so nothing here loops on its own: the page restarts all
 * four together one period after they started (lib/ui/replay-loop.ts) and
 * resets the clock with them. Lanes that drift apart are not "same serve, same
 * rules", whatever the copy says.
 *
 * Nothing on this page touches Ably. A live game is one click away — /play
 * against Jev, which hands out a watch link, or /arena for all four models at
 * once (gated, because it starts four real games). What one decision is, and
 * how the rest of it works, is on /how.
 *
 *   ?clean=1  strips everything except the lanes (screen recording)
 */

import Link from 'next/link';
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { hasAdminAccess } from '@/lib/config/admin';
import { ATARI_PAPER_URL, CLIP_SECONDS, MEASUREMENT } from '@/lib/config/site';
import { createReplayRunner } from '@/lib/game/replay';
import { LANES } from '@/lib/game/types';
import { replayPeriodMs } from '@/lib/ui/replay-loop';
import { headlineSentences, type ResultRow } from '@/lib/ui/stats';
import { HeaderNav, PrimaryLink, SiteFooter, SiteHeader } from './chrome';
import { Lanes } from './lanes';
import { ReplayTimer, useReplayClock } from './replay-timer';
import { useLaneSources, type LaneSource } from './use-lane';
import { useReplay } from './use-replay';

const REPLAY_URL = '/replay.json';

const HEADLINE = headlineSentences();

export interface HomeProps {
  clean: boolean;
  /** The results strip, measured. Counted on the server (see app/page.tsx). */
  rows: ResultRow[];
}

export function Home({ clean, rows }: HomeProps) {
  const { replay } = useReplay(REPLAY_URL);
  const clock = useReplayClock();

  // One clock for all four lanes. Each runner plays its own recording once; the
  // page deals a fresh set every `period`, which is the only thing that makes
  // the four restart on the same frame.
  const period = useMemo(() => replayPeriodMs(replay), [replay]);
  const [pass, setPass] = useState(0);

  useEffect(() => {
    if (period === null) return;
    const timer = setInterval(() => setPass((n) => n + 1), period);
    return () => clearInterval(timer);
  }, [period]);

  const { reset } = clock;
  useEffect(() => {
    reset();
  }, [pass, reset]);

  const make = useCallback((): LaneSource[] => {
    if (!replay) return [];
    const sources: LaneSource[] = [];
    // Lane order comes from the contract and is never re-sorted (SPEC b).
    for (const config of LANES) {
      const index = replay.lanes.findIndex((l) => l.model === config.id);
      if (index === -1) continue;
      sources.push({ config, runner: createReplayRunner(replay, index, { loop: false }) });
    }
    return sources;
  }, [replay]);

  const lanes = useLaneSources(make, `${replay?.recordedAt ?? 'pending'}#${pass}`);
  const stack = (
    <Lanes lanes={lanes} surface="home" recorded replay={replay} placeholder={LANES} onTime={clock.note} />
  );

  // Recording mode: the lanes and nothing else.
  if (clean) {
    return (
      <main className="mx-auto flex w-full max-w-[1280px] flex-1 flex-col justify-center px-4 py-6 lg:px-20">
        {stack}
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-[1280px] px-4 pb-6 lg:px-20">
      <SiteHeader home right={<HeaderNav />} />

      <Headline />

      <div className="flex items-baseline justify-between gap-4 pt-4 lg:pt-6">
        <p className="text-fg-muted text-[11.5px] lg:text-[13px]">
          Recorded run · {MEASUREMENT}
        </p>
        <ReplayTimer clock={clock} />
      </div>

      <section aria-label="Model lanes" className="pt-2.5 lg:pt-3">
        {stack}
      </section>

      <Results rows={rows} />

      <Story />

      <div className="pt-9 lg:pt-14">
        <SiteFooter />
      </div>
    </main>
  );
}

/* ---------------------------------------------------------------- the claim */

/**
 * One line, in the spirit of the measurement. The milliseconds are Jev's, so
 * they are the one orange thing in the sentence — orange is Jev's, and nothing
 * else's (design/SPEC.md, must-not-get-wrong c).
 */
function Headline() {
  const [value, unit] = HEADLINE.jevMs.split(' ');
  return (
    <div className="flex flex-col gap-2 pt-5 lg:gap-2.5 lg:pt-9">
      <h1 className="max-w-[980px] text-[21px] leading-[1.22] font-bold tracking-[-0.025em] text-pretty lg:text-[33px] lg:leading-[1.14]">
        {HEADLINE.jev}{' '}
        <span className="text-jev-ink whitespace-nowrap">
          <span className="mono tracking-[-0.04em]">{value}</span>
          <span className="pl-[0.22em]">{unit}</span>
        </span>
        . {HEADLINE.chat}
      </h1>
      <p className="text-fg-muted text-[14px] leading-[1.4] lg:text-[16px]">{HEADLINE.watch}</p>
    </div>
  );
}

/* -------------------------------------------------------- the results strip */

/** The columns, once. The window column names the seconds it counted. */
const COLUMNS: Array<{ key: keyof Pick<ResultRow, 'decisionsPerSec' | 'avgMs' | 'p95Ms' | 'inWindow'>; label: string }> = [
  { key: 'decisionsPerSec', label: 'decisions/s' },
  { key: 'avgMs', label: 'avg ms' },
  { key: 'p95Ms', label: 'p95 ms' },
  { key: 'inWindow', label: `in first ${CLIP_SECONDS} s` },
];

function cellText(row: ResultRow, key: (typeof COLUMNS)[number]['key']): string {
  const value = row[key];
  return key === 'decisionsPerSec' ? value.toFixed(2) : String(Math.round(value));
}

/**
 * The same four lanes as numbers: what the courts above just showed, in a form
 * you can quote. Jev's row is orange because Jev's ball is.
 */
function Results({ rows }: { rows: ResultRow[] }) {
  if (rows.length === 0) return null;
  return (
    <section aria-label="Measured results" className="pt-6 lg:pt-8">
      {/* The header uses the row grid, so the labels sit over their own
          columns at both widths. On a phone its name cell is empty and the
          row collapses to the labels alone. */}
      <div className="results-row border-hair border-b pb-1.5">
        <span className="results-name tag hidden lg:block">model</span>
        {COLUMNS.map((column) => (
          <span key={column.key} className="tag text-right text-[10px] lg:text-[12px]">
            {column.label}
          </span>
        ))}
      </div>

      <div className="flex flex-col">
        {rows.map((row) => {
          const ink = row.model === 'jev' ? 'text-jev-ink' : 'text-fg';
          return (
            <div key={row.model} className="results-row border-hair border-b py-2.5 lg:py-3">
              <div className="results-name flex min-w-0 flex-col gap-[2px]">
                <span className="truncate text-[14px] leading-[1.15] font-semibold lg:text-[15px]">
                  {row.label}
                </span>
                <span className="tag text-[10.5px] lg:text-[11px]">{row.provider}</span>
              </div>
              {COLUMNS.map((column) => (
                <span
                  key={column.key}
                  className={`mono ${ink} text-right text-[17px] leading-none font-medium tracking-[-0.02em] lg:text-[20px]`}
                >
                  {cellText(row, column.key)}
                </span>
              ))}
            </div>
          );
        })}
      </div>
    </section>
  );
}

/* --------------------------------------------------------------- the story */

/**
 * Three sentences, after the thing they describe. The first version of this
 * page opened with four paragraphs and buried the demo below them.
 */
function Story() {
  return (
    <section aria-label="What this is" className="flex max-w-[700px] flex-col gap-5 pt-7 lg:pt-9">
      <p className="text-fg-muted text-[14px] leading-[1.6] text-pretty lg:text-[15px]">
        Four lanes, one game: same serve, same rules, same question, asked of a different model in
        each. One answer moves the ball one step, so every ball travels at its own model&apos;s
        answer time and nothing is skipped or sped up. Jev is a typed-decision model rather than a
        chat model, and Pong is the Atari game chat models{' '}
        <a href={ATARI_PAPER_URL} className="text-fg hover:underline">
          handle worst
        </a>
        , so a loop that won&apos;t wait is the fair place to see what that&apos;s worth.
      </p>

      <p className="text-fg-muted text-[13px] leading-[1.6] text-pretty lg:text-[14px]">
        The four lanes are deliberately the four everyone knows. Since recording them the same
        question has been put to five more models, including GPT-6 Astra and Claude Fable 5.1.
        Same result.{' '}
        <Link href="/how#other-models" className="text-fg hover:underline">
          See the numbers
        </Link>
        .
      </p>

      <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:gap-3">
        <PrimaryLink href="/play">Play against Jev</PrimaryLink>
        <Link
          href="/how"
          className="border-btn-border text-fg rounded-control flex h-12 items-center justify-center border px-5 text-[16px] font-medium"
        >
          How it works
        </Link>
        <ArenaLink />
      </div>
    </section>
  );
}

/**
 * Whether this browser could use the arena is an external fact — a build flag
 * and a `localStorage` entry — so it is read as one. The server snapshot is
 * `false`, so the link is absent from the server markup and appears on
 * hydration rather than mismatching it.
 */
const NEVER_CHANGES = () => () => {};
const NOT_ON_THE_SERVER = () => false;

function ArenaLink(): ReactNode {
  const show = useSyncExternalStore(NEVER_CHANGES, hasAdminAccess, NOT_ON_THE_SERVER);
  if (!show) return null;
  return (
    <Link
      href="/arena"
      className="text-fg-muted hover:text-fg flex h-12 items-center text-[13px] lg:px-2"
    >
      Live arena
    </Link>
  );
}

export default Home;

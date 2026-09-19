'use client';

/**
 * /how — the page for anyone who wants to check the claim rather than take it.
 *
 * Everything here that can be derived is derived. The state block is built by
 * the engine, the question and its answers are imported from the file the
 * models are actually sent, and every number in the prose — steps per crossing,
 * paddle step, the play-mode floor — is the constant the game runs on. None of
 * it can drift from the thing it describes.
 *
 * It is deliberately short. The first version explained everything twice; a
 * sceptic wants the state, the question, the method and the source, in that
 * order, and wants them on one screen.
 */

import Link from 'next/link';
import type { ReactNode } from 'react';
import { HeaderNav, SiteFooter, SiteHeader } from './chrome';
import { ATARI_PAPER_URL, JEV_CHANGELOG_URL, REPO_URL } from '@/lib/config/site';
import { DECISION_INSTRUCTIONS, MOVE_CRITERIA, stateForModel } from '@/lib/decide/prompt';
import { createEngine, serve, toDecisionState } from '@/lib/game/engine';
import {
  accuracySentence,
  COMPARISON_FLOOR_MS,
  COMPARISON_FROM,
  COMPARISON_MEASURED_AT,
  COMPARISON_STATES,
  comparisonRows,
} from '@/lib/ui/comparison';
import {
  MODEL_PADDLE_STEP,
  PLAY_MIN_STEP_MS,
  SEGMENTS_PER_CROSSING,
} from '@/lib/game/types';

export function How() {
  return (
    <main className="mx-auto w-full max-w-[1280px] px-4 pb-6 lg:px-20">
      <SiteHeader right={<HeaderNav />} />

      <h1 className="max-w-[760px] pt-5 text-[28px] leading-[1.1] font-bold tracking-[-0.03em] lg:pt-10 lg:text-[44px]">
        How it works
      </h1>
      <p className="text-fg-muted max-w-[700px] pt-2.5 text-[16px] leading-[1.45] text-pretty lg:pt-4 lg:text-[20px]">
        Four models, one game, and a number that is only ever the time the model took.
      </p>

      <div className="flex flex-col gap-8 pt-8 lg:gap-11 lg:pt-11">
        <WhyPong />
        <Rules />
        <WhatTheModelSees />
        <VsChatModels />
        <OtherModels />
      <OverAbly />
        <ReadTheCode />
      </div>

      <div className="pt-10 lg:pt-14">
        <SiteFooter />
      </div>
    </main>
  );
}

/* ------------------------------------------------------------------ why Pong */

function WhyPong() {
  return (
    <Section id="why" title="Why Pong">
      <Body>
        Pong is the Atari game chat models handle worst: below random in the{' '}
        <Cite href={ATARI_PAPER_URL}>Atari-GPT benchmark</Cite>, mostly because deciding takes them
        longer than the game gives them. A live loop is the one job where speed is the whole point,
        so it is the fair place to measure a model built to answer in milliseconds.{' '}
        <Cite href={JEV_CHANGELOG_URL}>Jev</Cite> is a typed-decision model: a small state goes in, a
        typed answer comes out.
      </Body>
    </Section>
  );
}

/* -------------------------------------------------------------------- rules */

const RULES: string[] = [
  'Same serve, same rules, same question in every lane.',
  `One decision moves the ball one step. ${SEGMENTS_PER_CROSSING} steps cross the court.`,
  `The model's paddle moves at most ${MODEL_PADDLE_STEP} units per decision, which is enough reach over a crossing to get anywhere the ball can go.`,
  'The left paddle is a script, not a model. It always returns the ball and it takes no time to decide, so the only difference between lanes is the model on the right.',
  `When you play, a step never finishes in under ${PLAY_MIN_STEP_MS} ms. Jev at a couple of hundred is a reflex test rather than a game. The floor paces the ball, not the clock: the number beside the court is still Jev's real round trip.`,
];

function Rules() {
  return (
    <Section id="rules" title="The rules">
      <ul className="flex max-w-[700px] flex-col gap-2">
        {RULES.map((rule) => (
          <li
            key={rule}
            className="text-fg-muted flex gap-3 text-[13px] leading-[1.55] text-pretty lg:text-[14px]"
          >
            <span aria-hidden className="text-fg-muted pt-[7px]">
              <Bullet />
            </span>
            <span className="min-w-0">{rule}</span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function Bullet() {
  return (
    <svg width="5" height="5" viewBox="0 0 5 5" aria-hidden className="block">
      <circle cx="2.5" cy="2.5" r="2.5" fill="currentColor" />
    </svg>
  );
}

/* ---------------------------------------------- what counts as one decision */

/**
 * The comparison is only a fair fight if every lane is asked the same thing, so
 * the page shows the thing rather than claiming it.
 *
 * Nothing here is typed out by hand. The state block is built by the engine —
 * a fresh game, served, as the right-hand paddle sees it — and the question and
 * its answers are imported from lib/decide/prompt.ts, which is the file the
 * models are actually sent. Neither can drift from what goes on the wire.
 */
const SAMPLE_SEED = 20260917;

/** Exactly the JSON a model is given on a decision. Any seed gives this shape. */
const SAMPLE_STATE = JSON.stringify(
  stateForModel(toDecisionState(serve(createEngine(SAMPLE_SEED)), 'right')),
);

/** "up · down · stay" — the three answers, from the criteria themselves. */
const ANSWERS = Object.keys(MOVE_CRITERIA).join(' · ');

function WhatTheModelSees() {
  return (
    <Section id="state" title="What the model sees">
      <div className="flex max-w-[700px] flex-col gap-1.5">
        <p className="text-fg-muted text-[12px] lg:text-[13px]">
          The whole state, numbers only, {SAMPLE_STATE.length} bytes:
        </p>
        <pre className="mono bg-surface border-hair rounded-card border px-3.5 py-3 text-[11px] leading-[1.6] break-all whitespace-pre-wrap lg:text-[12px]">
          {SAMPLE_STATE}
        </pre>
      </div>

      <div className="flex max-w-[700px] flex-col gap-1.5 pt-1">
        <p className="text-fg-muted text-[12px] lg:text-[13px]">
          The question, in the words every lane is given:
        </p>
        <p className="text-fg text-[12px] leading-[1.5] lg:text-[13px]">{DECISION_INSTRUCTIONS}</p>
        <p className="text-fg-muted text-[12px] lg:text-[13px]">
          Three answers: <span className="mono text-fg">{ANSWERS}</span>.
        </p>
      </div>
    </Section>
  );
}

/* -------------------------------------------------- Jev vs the chat models */

function VsChatModels() {
  return (
    <Section id="method" title="Jev vs the chat models">
      <Body>
        Jev answers through the AI SDK <Mono>experimental_evaluate</Mono> API. The chat models get
        the identical state and the identical words through structured output, at temperature 0,
        with reasoning off. Nobody gets a retry. The number on a lane is the round trip of that one
        call, timed on the server, and nothing else.
      </Body>
    </Section>
  );
}

/* ------------------------------------------------------ the other models */

function OtherModels() {
  return (
    <Section id="other-models" title="Other models, same question">
      <Body>
        The four lanes were chosen to be simple: one typed-decision model against the three chat
        models most people recognise, recorded next to the Gateway so nothing on the front page is
        anyone&apos;s broadband. After launch, people asked about the newest frontier models, about Qwen,
        and about the smallest chat models. So the same question went to them too, on {COMPARISON_MEASURED_AT}: {COMPARISON_STATES} real game
        states, one call per decision, sequential, reasoning switched to the lowest setting each
        provider accepts. The principle holds: nothing gets near Jev&apos;s time without starting to
        get the question wrong, and nothing is more accurate.
      </Body>

      <div className="max-w-[700px] overflow-x-auto">
        <table className="w-full min-w-[520px] text-[12px] lg:text-[13px]">
          <thead>
            <tr className="text-fg-muted border-hair border-b text-left">
              <th className="py-1.5 pr-3 font-medium">Model</th>
              <th className="py-1.5 pr-3 font-medium">Setting</th>
              <th className="py-1.5 pr-3 text-right font-medium">Correct</th>
              <th className="py-1.5 pr-3 text-right font-medium">Median</th>
              <th className="py-1.5 pr-3 text-right font-medium">p95</th>
              <th className="py-1.5 text-right font-medium">vs Jev</th>
            </tr>
          </thead>
          <tbody>
            {comparisonRows().map((row) => (
              <tr key={`${row.model} ${row.setting}`} className="border-hair border-b">
                <td className={`py-1.5 pr-3 font-semibold ${row.model === 'Jev' ? 'text-jev-ink' : 'text-fg'}`}>
                  {row.model}
                </td>
                <td className="text-fg-muted py-1.5 pr-3">{row.setting}</td>
                <td className="mono py-1.5 pr-3 text-right">
                  {row.correct}/{row.answered}
                </td>
                <td className="mono py-1.5 pr-3 text-right">{row.adjustedP50Ms} ms</td>
                <td className="mono py-1.5 pr-3 text-right">{row.adjustedP95Ms} ms</td>
                <td className="mono py-1.5 text-right">{row.timesJev}x</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Body>
        Measured from {COMPARISON_FROM}, which is where the lanes were recorded, so Jev&apos;s
        median here is the same round trip the front page shows.
        {COMPARISON_FLOOR_MS > 0
          ? ` Every row carries the same ${COMPARISON_FLOOR_MS} ms of request overhead from there, removed before the columns are shown.`
          : ''}{' '}
        Astra at medium effort landed with low and high, all within 200 ms of each other on a
        one-token answer, and Fable at high effort came in at 3.6 s with an 11 s p95, so neither
        setting is listed twice: the setting is not what makes them slow.{' '}
        {accuracySentence(comparisonRows())} Not smarter. Faster.
      </Body>
    </Section>
  );
}

/* ------------------------------------------------------------- the Ably part */

function OverAbly() {
  return (
    <Section id="ably" title="Where Ably comes in">
      <Body>
        <Mono>POST /api/game</Mono> leaves a worker running on Vercel. It joins the channel{' '}
        <Mono>pong:game:&lt;id&gt;</Mono> as an ordinary member, announces itself in presence as the
        agent, runs the physics and publishes a state snapshot after every decision. Your browser is
        another member of the same channel: present as a player, publishing <Mono>input</Mono>{' '}
        messages carrying one move, drawing what the channel says rather than a simulation of its
        own.
      </Body>
      <Body>
        That is why the watch link works. Anyone who opens it attaches to the same channel with
        rewind, so the current state arrives immediately instead of at the next decision, and the
        number of people watching is that presence set, counted.
      </Body>
    </Section>
  );
}

/* ----------------------------------------------------------- read the code */

/** The reading order from the README, so the two cannot disagree. */
const READING: Array<{ path: string; note: string }> = [
  {
    path: 'lib/game/types.ts',
    note: 'the contract: the court, one decision = one tick, and the bytes a model is given',
  },
  {
    path: 'lib/game/engine.ts',
    note: 'the whole game as pure functions, including the paddle that never misses',
  },
  { path: 'lib/decide/prompt.ts', note: 'the one question every model is asked, and its answers' },
  {
    path: 'lib/decide/jev.ts',
    note: 'evaluate, for Jev. lib/decide/llm.ts is structured output, for the rest',
  },
  {
    path: 'lib/worker/game-worker.ts',
    note: 'the agent as a member of the channel: the decision loop and the wire',
  },
  { path: 'lib/worker/referee.ts', note: 'when a game stops, with no clock of its own' },
  { path: 'app/api/game/route.ts', note: 'one HTTP request, one function, one game' },
  {
    path: 'lib/ably/hooks.ts',
    note: 'everything a browser does: subscribe, be present, publish input',
  },
];

function ReadTheCode() {
  return (
    <Section id="code" title="Read the code">
      <Body>It is all public, and it is meant to be read. Eight files, in order.</Body>

      <ol className="flex max-w-[700px] flex-col gap-2 pt-1">
        {READING.map((entry, i) => (
          <li key={entry.path} className="flex gap-3 text-[12px] leading-[1.5] lg:text-[13px]">
            <span className="mono text-fg-muted w-4 shrink-0 text-right">{i + 1}</span>
            <span className="min-w-0">
              <SourceLink path={entry.path} />
              <span className="text-fg-muted"> · {entry.note}</span>
            </span>
          </li>
        ))}
      </ol>

      <p className="pt-4">
        <Link href="/play" className="text-fg text-[13px] hover:underline">
          Play against Jev
        </Link>
        <span className="text-fg-muted text-[13px]"> · </span>
        <Link href="/" className="text-fg text-[13px] hover:underline">
          Back to the lanes
        </Link>
      </p>
    </Section>
  );
}

function SourceLink({ path }: { path: string }) {
  if (REPO_URL === null) return <Mono>{path}</Mono>;
  return (
    <a href={`${REPO_URL}/blob/main/${path}`} className="mono text-fg hover:underline">
      {path}
    </a>
  );
}

/* --------------------------------------------------------------- the type */

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <h2 id={id} className="text-[15px] font-semibold lg:text-[16px]">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Body({ children }: { children: ReactNode }) {
  return (
    <p className="text-fg-muted max-w-[700px] text-[13px] leading-[1.6] text-pretty lg:text-[14px]">
      {children}
    </p>
  );
}

function Mono({ children }: { children: ReactNode }) {
  return <span className="mono text-fg">{children}</span>;
}

function Cite({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} className="text-fg hover:underline">
      {children}
    </a>
  );
}

export default How;

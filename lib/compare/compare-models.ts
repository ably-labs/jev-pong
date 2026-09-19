/**
 * lib/compare/compare-models.ts — the same question, put to other models.
 *
 * The four lanes on the home page are a recording. This is the other half of
 * the evidence: one model at a time is given the same real game states, the
 * same instruction and the same three answers, one call per state, sequential,
 * with reasoning switched to the lowest setting the provider accepts. What
 * comes back is the row for one model: how many it answered, how many it got
 * right, and the median and p95 of the clock run around the model call.
 *
 * No CLI and no filesystem here, so it can run in two places identically:
 *   - `POST /api/compare`, from a Vercel function — the one that matters,
 *     because the latency is then function-to-Gateway rather than somebody's
 *     broadband;
 *   - `scripts/compare-models.ts`, which drives that route lane by lane from a
 *     laptop and writes `public/model-comparison.json`.
 *
 * Jev is measured the way the game measures it (`decideWithJev`). A chat model
 * is asked for structured output exactly as the chat lanes are (`decideWithLlm`
 * in ../decide/llm.ts), except that a lane here may carry its own provider
 * options, because the newest reasoning models refuse the generic "off" switch
 * and each takes a different lowest setting.
 */

import { generateObject, type JSONValue } from 'ai';
import { decideWithJev } from '../decide/jev';
import { MAX_OUTPUT_TOKENS, moveSchema, parseMove, reasoningOff } from '../decide/llm';
import { LLM_SYSTEM_PROMPT, expectedMove, stateForModel } from '../decide/prompt';
import { applyTick, createEngine, serve, toDecisionState } from '../game/engine';
import type { DecisionState, Move } from '../game/types';

export interface CompareLane {
  /** Short stable key, the thing the route and the script pass around. */
  key: string;
  /** Gateway model id. */
  id: string;
  /** How the table names it. */
  model: string;
  provider: string;
  /** The reasoning setting, in words the table can show. */
  setting: string;
  /** Present only when the generic `reasoningOff` switch is not what this model takes. */
  providerOptions?: Record<string, Record<string, JSONValue>>;
}

/**
 * Every model the comparison can run. The published subset is whatever the
 * script is asked for; the extra Astra and Fable settings exist so the claim
 * "the setting made no difference" is measured rather than assumed.
 */
export const COMPARE_LANES: readonly CompareLane[] = [
  { key: 'jev', id: 'typesafe-ai/jev', model: 'Jev', provider: 'TypeSafe AI', setting: 'evaluate' },
  { key: 'haiku', id: 'anthropic/claude-haiku-4.5', model: 'Claude Haiku 4.5', provider: 'Anthropic', setting: 'thinking off' },
  { key: 'sol', id: 'openai/gpt-5.6-sol', model: 'GPT-5.6 Sol', provider: 'OpenAI', setting: 'default' },
  // Astra takes low, medium, high, xhigh or max; the Gateway refuses "minimal".
  { key: 'astra-fast-low', id: 'openai/gpt-6-astra-fast', model: 'GPT-6 Astra-fast', provider: 'OpenAI', setting: 'reasoning effort low', providerOptions: { openai: { reasoningEffort: 'low' } } },
  { key: 'astra-low', id: 'openai/gpt-6-astra', model: 'GPT-6 Astra', provider: 'OpenAI', setting: 'reasoning effort low', providerOptions: { openai: { reasoningEffort: 'low' } } },
  { key: 'astra-medium', id: 'openai/gpt-6-astra', model: 'GPT-6 Astra', provider: 'OpenAI', setting: 'reasoning effort medium', providerOptions: { openai: { reasoningEffort: 'medium' } } },
  { key: 'astra-high', id: 'openai/gpt-6-astra', model: 'GPT-6 Astra', provider: 'OpenAI', setting: 'reasoning effort high', providerOptions: { openai: { reasoningEffort: 'high' } } },
  // Fable 5.1 refuses thinking "disabled"; it wants "adaptive" plus an effort.
  { key: 'fable-low', id: 'anthropic/claude-fable-5.1', model: 'Claude Fable 5.1', provider: 'Anthropic', setting: 'adaptive thinking, effort low', providerOptions: { anthropic: { thinking: { type: 'adaptive' }, effort: 'low' } } },
  // Qwen, because Jay Bell's Trellis replay compared Jev with a Qwen 235B-class model.
  { key: 'qwen-flash', id: 'alibaba/qwen3.8-flash', model: 'Qwen 3.8 Flash', provider: 'Alibaba', setting: 'default' },
  { key: 'qwen-27b', id: 'alibaba/qwen3.8-27b', model: 'Qwen 3.8 27B', provider: 'Alibaba', setting: 'default' },
  { key: 'qwen-max', id: 'alibaba/qwen3.8-max', model: 'Qwen 3.8 Max', provider: 'Alibaba', setting: 'default' },
  { key: 'qwen-235b', id: 'alibaba/qwen-3-235b', model: 'Qwen 3 235B', provider: 'Alibaba', setting: 'default' },
  // The smallest, cheapest chat models on the Gateway: the fair "fastest chat model" candidates.
  { key: 'gemini-flash-lite', id: 'google/gemini-3.5-flash-lite', model: 'Gemini 3.5 Flash-Lite', provider: 'Google', setting: 'thinking off' },
  { key: 'gpt-nano', id: 'openai/gpt-5.4-nano', model: 'GPT-5.4 Nano', provider: 'OpenAI', setting: 'default' },
  { key: 'ministral-3b', id: 'mistral/ministral-3b', model: 'Ministral 3B', provider: 'Mistral', setting: 'default' },
  { key: 'nemotron-nano', id: 'nvidia/nemotron-nano-9b-v2', model: 'Nemotron Nano 9B', provider: 'NVIDIA', setting: 'default' },
  { key: 'fable-high', id: 'anthropic/claude-fable-5.1', model: 'Claude Fable 5.1', provider: 'Anthropic', setting: 'adaptive thinking, effort high', providerOptions: { anthropic: { thinking: { type: 'adaptive' }, effort: 'high' } } },
];

export const COMPARE_LANE_KEYS = COMPARE_LANES.map((l) => l.key);

export function compareLane(key: string): CompareLane | undefined {
  return COMPARE_LANES.find((l) => l.key === key);
}

/** Calls the model does not count toward the row; they warm the connection. */
export const WARMUP_CALLS = 2;
export const DEFAULT_STATES = 30;
export const MAX_STATES = 60;

/**
 * A spread of real game states from the engine: three seeds, a rally each,
 * interleaved so the ball is coming toward the paddle in half of them and
 * moving away in the other half. Deterministic, so every lane sees the same
 * states in the same order.
 */
export function compareStates(n: number = DEFAULT_STATES): DecisionState[] {
  const all: DecisionState[] = [];
  for (const seed of [11, 23, 37]) {
    let s = serve(createEngine(seed, 1));
    for (let i = 0; i < 40 && all.length < n * 2; i += 1) {
      const d = toDecisionState(s, 'right');
      all.push(d);
      s = applyTick(s, expectedMove(d), 'auto');
      if (s.status === 'point') s = serve(s);
    }
  }
  const toward = all.filter((d) => d.dir === 'toward');
  const away = all.filter((d) => d.dir === 'away');
  const mixed: DecisionState[] = [];
  for (let i = 0; mixed.length < n && (toward[i] || away[i]); i += 1) {
    if (toward[i]) mixed.push(toward[i]);
    if (away[i] && mixed.length < n) mixed.push(away[i]);
  }
  return mixed;
}

export interface CompareCall {
  move: Move | null;
  ms: number;
  /** First Gateway warning, if any; says whether the reasoning switch was honoured. */
  warning?: string;
  error?: string;
}

/** One decision from one lane, timed around the model call. */
export async function callLane(lane: CompareLane, state: DecisionState): Promise<CompareCall> {
  const startedAt = performance.now();
  try {
    if (lane.key === 'jev') {
      const r = await decideWithJev(state);
      return { move: r.move, ms: r.latencyMs };
    }
    const r = await generateObject({
      model: lane.id,
      schema: moveSchema,
      schemaName: 'PaddleMove',
      schemaDescription: 'The move for the right paddle on this tick.',
      system: LLM_SYSTEM_PROMPT,
      prompt: JSON.stringify(stateForModel(state)),
      temperature: 0,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      maxRetries: 0,
      providerOptions: lane.providerOptions ?? reasoningOff(lane.id),
    });
    const ms = performance.now() - startedAt;
    const warning = r.warnings?.[0] ? short(JSON.stringify(r.warnings[0])) : undefined;
    return { move: parseMove(r.object), ms, warning };
  } catch (e) {
    return { move: null, ms: performance.now() - startedAt, error: short(e instanceof Error ? e.message : String(e)) };
  }
}

function short(text: string): string {
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

export interface CompareRow {
  key: string;
  model: string;
  provider: string;
  setting: string;
  states: number;
  answered: number;
  correct: number;
  p50Ms: number;
  p95Ms: number;
  /** Every counted latency, rounded, so a reader can recompute the percentiles. */
  latenciesMs: number[];
  warning?: string;
  error?: string;
}

/** Nearest-rank percentile on a copy; NaN for an empty list. */
export function percentile(values: readonly number[], q: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
}

export interface RunLaneOptions {
  states?: DecisionState[];
  /** Test seam: replaces the model call. */
  call?: (lane: CompareLane, state: DecisionState) => Promise<CompareCall>;
  onProgress?: (done: number, total: number, last: CompareCall) => void;
}

/** Runs one lane over the states, sequentially, and summarises it. */
export async function runLane(lane: CompareLane, opts: RunLaneOptions = {}): Promise<CompareRow> {
  const states = opts.states ?? compareStates();
  const call = opts.call ?? callLane;
  for (let i = 0; i < Math.min(WARMUP_CALLS, states.length); i += 1) await call(lane, states[i]);

  const latencies: number[] = [];
  let answered = 0;
  let correct = 0;
  let warning: string | undefined;
  let error: string | undefined;
  for (const [i, state] of states.entries()) {
    const r = await call(lane, state);
    warning ??= r.warning;
    error ??= r.error;
    if (r.move !== null) {
      answered += 1;
      latencies.push(r.ms);
      if (r.move === expectedMove(state)) correct += 1;
    }
    opts.onProgress?.(i + 1, states.length, r);
  }
  return {
    key: lane.key,
    model: lane.model,
    provider: lane.provider,
    setting: lane.setting,
    states: states.length,
    answered,
    correct,
    p50Ms: Math.round(percentile(latencies, 0.5)),
    p95Ms: Math.round(percentile(latencies, 0.95)),
    latenciesMs: latencies.map(Math.round),
    ...(warning !== undefined ? { warning } : {}),
    ...(error !== undefined ? { error } : {}),
  };
}

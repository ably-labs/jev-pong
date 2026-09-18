/**
 * The chat-LLM lanes: the same decision, put to a language model.
 *
 * A lane here gets the identical DecisionState and the identical instruction
 * text as Jev (./prompt.ts), through the same Gateway. What differs is how the
 * answer comes back: a language model cannot answer a typed question, so it
 * returns structured output — a one-field object checked against `moveSchema`.
 *
 * The call is kept as small as the comparison allows: one tiny object,
 * temperature 0, few output tokens, and reasoning switched off wherever the
 * provider has a switch for it (see `reasoningOff`). A model that stops to think
 * before it answers is latency the demo would be measuring by accident. As in
 * ./jev.ts, the clock runs around the model call alone and `maxRetries: 0` keeps
 * a hidden retry out of the number.
 */
import { generateObject, type JSONValue, type LanguageModel } from 'ai';
import { z } from 'zod';
import type { DecisionState, Move } from '../game/types';
import { LLM_SYSTEM_PROMPT, MOVES, stateForModel } from './prompt';
import type { ModelDecision } from './types';

/** Enough for the object plus the small amount of slack providers need. */
export const MAX_OUTPUT_TOKENS = 256;

export const moveSchema = z.object({ move: z.enum(MOVES) });

export interface LlmOptions {
  signal?: AbortSignal;
  /** Test seam: a language model instance instead of the Gateway string id. */
  modelOverride?: LanguageModel;
}

/** Validates whatever came back and returns the move, or throws a short reason. */
export function parseMove(value: unknown): Move {
  const parsed = moveSchema.safeParse(value);
  if (parsed.success) return parsed.data.move;
  throw new Error(`Model returned an unusable decision: ${describe(value)}`);
}

function describe(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

/**
 * Provider-specific switches that stop a model thinking before it answers.
 * Unknown providers get nothing, which is the safe default.
 *
 * There is no openai entry on purpose: verified live on 2026-09-17, the Gateway
 * answers reasoningEffort for openai/gpt-5.6-sol with an "unsupported feature"
 * warning and drops it. (It warns about temperature on the same model too, from
 * the opposite direction — the two warnings contradict each other, so the lane
 * keeps temperature 0 for parity with the others and lets the Gateway drop what
 * it will not take.) Add an entry here if a reasoning model becomes a lane.
 */
export function reasoningOff(gatewayModelId: string): Record<string, Record<string, JSONValue>> | undefined {
  switch (gatewayModelId.split('/')[0]) {
    case 'anthropic':
      return { anthropic: { thinking: { type: 'disabled' } } };
    case 'google':
      return { google: { thinkingConfig: { thinkingBudget: 0 } } };
    default:
      return undefined;
  }
}

export async function decideWithLlm(
  gatewayModelId: string,
  state: DecisionState,
  opts: LlmOptions = {},
): Promise<ModelDecision> {
  const model: LanguageModel = opts.modelOverride ?? gatewayModelId;

  const startedAt = performance.now();
  const result = await generateObject({
    model,
    schema: moveSchema,
    schemaName: 'PaddleMove',
    schemaDescription: 'The move for the right paddle on this tick.',
    system: LLM_SYSTEM_PROMPT,
    prompt: JSON.stringify(stateForModel(state)),
    temperature: 0,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    maxRetries: 0,
    abortSignal: opts.signal,
    providerOptions: reasoningOff(gatewayModelId),
  });
  const latencyMs = performance.now() - startedAt;

  return { move: parseMove(result.object), latencyMs };
}

/**
 * The Jev lane: one `experimental_evaluate` call per decision.
 *
 * Jev is not a chat model. It is handed the state as data and answers the typed
 * question from ./prompt.ts, so there is no prose to write and nothing to parse
 * back. The chat lanes in ./llm.ts are given the identical state and the
 * identical words through structured output instead, and that difference is the
 * whole comparison.
 *
 * The clock starts immediately before the call and stops immediately after it,
 * so `latencyMs` is the model call and nothing else — no engine work, no Ably
 * publish. `maxRetries: 0` is what keeps it honest: a retry inside the SDK
 * would be charged to this decision's latency and make the lane look slower
 * than the model is. One call, one tick.
 */
import { experimental_evaluate as evaluate, type Experimental_EvaluationModel } from 'ai';
import { LANES, type DecisionState } from '../game/types';
import { MOVE_QUESTIONS, isMove, stateForModel } from './prompt';
import type { ModelDecision } from './types';

export interface JevOptions {
  signal?: AbortSignal;
  /** Test seam: an evaluation model instance instead of the Gateway string id. */
  modelOverride?: Experimental_EvaluationModel;
}

/** The Gateway id for the Jev lane, read from the shared LANES contract. */
export function jevGatewayId(): string {
  const lane = LANES.find((l) => l.id === 'jev');
  if (!lane?.gateway) throw new Error('No Gateway id configured for the Jev lane.');
  return lane.gateway;
}

export async function decideWithJev(
  state: DecisionState,
  opts: JevOptions = {},
): Promise<ModelDecision> {
  const model = opts.modelOverride ?? jevGatewayId();

  const startedAt = performance.now();
  const result = await evaluate({
    model,
    state: stateForModel(state),
    questions: MOVE_QUESTIONS,
    maxRetries: 0,
    abortSignal: opts.signal,
  });
  const latencyMs = performance.now() - startedAt;

  const choice = result.answers.move.choice;
  if (!isMove(choice)) throw new Error(`Jev returned an unknown choice: ${String(choice)}`);
  return { move: choice, latencyMs };
}

/**
 * The one entry point the rest of the app uses to turn a DecisionState into a Move.
 *
 * It reads the lane's route from the LANES contract — `kind: 'evaluate'` goes to
 * Jev (./jev.ts), everything else to structured output (./llm.ts) — puts a hard
 * timeout around the call, and reports the latency that call measured. Nothing
 * else is added to that number.
 *
 * Everything that can go wrong comes back as a typed DecideResponse: callers never
 * see an exception, a stack, or a provider message that might carry credentials.
 */
import { APICallError } from 'ai';
import { LANES, PLAYABLE } from '../game/types';
import type {
  DecideErrorCode,
  DecideRequest,
  DecideResponse,
  ModelId,
} from '../game/types';
import { decideWithJev } from './jev';
import { decideWithLlm } from './llm';

export { expectedMove, stateForModel, DECISION_INSTRUCTIONS, MOVE_CRITERIA } from './prompt';
export { decideWithJev } from './jev';
export { decideWithLlm, parseMove } from './llm';
export type { ModelDecision } from './types';

export const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * The lane ids that have a Gateway model behind them, and so the only ones an
 * API route accepts. `human`, `wall` and `mock` are decided locally.
 */
export const GATEWAY_MODELS = ['jev', 'haiku', 'gpt', 'gemini'] as const satisfies readonly ModelId[];

export interface DecideOptions {
  signal?: AbortSignal;
  /** Hard ceiling on one model call. Default 20000ms. */
  timeoutMs?: number;
}

type DecideFailure = Extract<DecideResponse, { ok: false }>;

/** Deciders that never reach this module: the human, the wall, and the test mock. */
const LOCAL_MODELS: readonly ModelId[] = ['human', 'wall', 'mock'];

function isKnownModel(model: string): model is ModelId {
  return LOCAL_MODELS.some((id) => id === model) || LANES.some((lane) => lane.id === model);
}

function fail(error: DecideErrorCode, message: string): DecideFailure {
  return { ok: false, error, message };
}

export async function decide(req: DecideRequest, opts: DecideOptions = {}): Promise<DecideResponse> {
  const { model, state, mode } = req;

  if (!isKnownModel(model)) {
    return fail('bad_request', `Unknown model "${safeText(String(model))}".`);
  }
  if (mode === 'play' && !PLAYABLE.includes(model)) {
    return fail(
      'model_not_allowed',
      `"${model}" is watch-only. Play mode is limited to: ${PLAYABLE.join(', ')}.`,
    );
  }

  const lane = LANES.find((l) => l.id === model);
  if (!lane || lane.kind === 'local' || lane.gateway === null) {
    return fail('bad_request', `"${model}" is decided locally and has no model call.`);
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const forwardAbort = () => controller.abort();
  if (opts.signal?.aborted) controller.abort();
  else opts.signal?.addEventListener('abort', forwardAbort, { once: true });

  try {
    const decision =
      lane.kind === 'evaluate'
        ? await decideWithJev(state, { signal: controller.signal })
        : await decideWithLlm(lane.gateway, state, { signal: controller.signal });

    return { ok: true, move: decision.move, latencyMs: Math.round(decision.latencyMs), model };
  } catch (err) {
    if (timedOut) return fail('model_error', `Timed out after ${timeoutMs}ms.`);
    if (opts.signal?.aborted) return fail('model_error', 'Cancelled.');
    return mapDecideError(err);
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', forwardAbort);
  }
}

/**
 * Turns anything thrown by the SDK into a typed failure.
 * 402 (or a quota_for_entity_exceeded payload) = the Gateway budget is spent.
 */
export function mapDecideError(err: unknown): DecideFailure {
  const status = statusCodeOf(err);
  const haystack = detectionText(err);

  if (status === 402 || /quota_for_entity_exceeded/i.test(haystack)) {
    return fail('out_of_credits', 'AI Gateway budget exhausted for this project.');
  }
  if (status === 429) {
    return fail('rate_limited', 'AI Gateway rate limit reached.');
  }
  return fail('model_error', safeText(messageOf(err)));
}

function statusCodeOf(err: unknown): number | undefined {
  if (APICallError.isInstance(err)) return err.statusCode;
  const status = (err as { statusCode?: unknown } | null)?.statusCode;
  return typeof status === 'number' ? status : undefined;
}

function messageOf(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return typeof err === 'string' && err ? err : 'The model call failed.';
}

/** Message plus response payload, used only to classify. Never returned to callers. */
function detectionText(err: unknown): string {
  const parts = [messageOf(err)];
  if (APICallError.isInstance(err)) {
    if (err.responseBody) parts.push(err.responseBody);
    if (err.data !== undefined) {
      try {
        parts.push(JSON.stringify(err.data));
      } catch {
        /* not serialisable, ignore */
      }
    }
  }
  const type = (err as { type?: unknown } | null)?.type;
  if (typeof type === 'string') parts.push(type);
  return parts.join(' ');
}

/** One line, no stack, no key-shaped strings, and short enough for a lane label. */
function safeText(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  const redacted = oneLine.replace(/\b(?:sk|vck|eyJ)[A-Za-z0-9._-]{12,}/g, '[redacted]');
  if (!redacted) return 'The model call failed.';
  return redacted.length > 200 ? `${redacted.slice(0, 197)}...` : redacted;
}

import { Experimental_EvaluationMockModelV4 as EvaluationMockModel } from 'ai/test';
import { describe, expect, it } from 'vitest';
import type { DecisionState, Move } from '../game/types';
import { decideWithJev, jevGatewayId } from './jev';
import { DECISION_INSTRUCTIONS, MOVE_CRITERIA, expectedMove } from './prompt';

type EvaluateCall = Parameters<EvaluationMockModel['doEvaluate']>[0];

function state(overrides: Partial<DecisionState> = {}): DecisionState {
  return {
    court: { w: 160, h: 100 },
    ball: { x: 80, y: 42, vx: 26.67, vy: 8 },
    paddle: { y: 30, h: 20 },
    interceptY: 66,
    dir: 'toward',
    ...overrides,
  };
}

/** An evaluation model that answers with the given choice and records the call. */
function mockJev(choice: string, calls: EvaluateCall[] = []) {
  return new EvaluationMockModel({
    provider: 'typesafe-ai',
    modelId: 'jev',
    supportedQuestionTypes: ['choice'],
    doEvaluate: async (options) => {
      calls.push(options);
      return { answers: { move: { type: 'choice', choice } }, warnings: [] };
    },
  });
}

describe('decideWithJev', () => {
  it.each(['up', 'down', 'stay'] satisfies Move[])('maps the "%s" choice to that move', async (choice) => {
    const result = await decideWithJev(state(), { modelOverride: mockJev(choice) });
    expect(result.move).toBe(choice);
  });

  it('measures the call and reports a non-negative latency', async () => {
    const result = await decideWithJev(state(), { modelOverride: mockJev('down') });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(result.latencyMs)).toBe(true);
  });

  it('asks the shared question against the DecisionState only', async () => {
    const calls: EvaluateCall[] = [];
    await decideWithJev(state(), { modelOverride: mockJev('down', calls) });

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.state).toEqual({
      court: { w: 160, h: 100 },
      ball: { x: 80, y: 42, vx: 26.67, vy: 8 },
      paddle: { y: 30, h: 20 },
      interceptY: 66,
      dir: 'toward',
    });
    expect(call.questions.move).toEqual({
      type: 'choice',
      instructions: DECISION_INSTRUCTIONS,
      criteria: MOVE_CRITERIA,
    });
  });

  it('agrees with the local rule on a clear state', async () => {
    const clear = state({ paddle: { y: 30, h: 20 }, interceptY: 66 });
    const result = await decideWithJev(clear, { modelOverride: mockJev(expectedMove(clear)) });
    expect(result.move).toBe('down');
  });

  it('rejects a choice that is not a move', async () => {
    // The SDK rejects an option outside the criteria first; the isMove guard in
    // jev.ts is the backstop for a provider that ever slips one through.
    await expect(decideWithJev(state(), { modelOverride: mockJev('left') })).rejects.toThrow(
      /unknown (option|choice)/i,
    );
  });

  it('passes the abort signal through to the model', async () => {
    const calls: EvaluateCall[] = [];
    const controller = new AbortController();
    await decideWithJev(state(), { modelOverride: mockJev('stay', calls), signal: controller.signal });
    expect(calls[0].abortSignal).toBe(controller.signal);
  });
});

describe('jevGatewayId', () => {
  it('reads the Gateway id from the shared lane contract', () => {
    expect(jevGatewayId()).toBe('typesafe-ai/jev');
  });
});

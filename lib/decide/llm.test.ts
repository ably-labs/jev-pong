import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import type { DecisionState } from '../game/types';
import { MAX_OUTPUT_TOKENS, decideWithLlm, parseMove, reasoningOff } from './llm';
import { LLM_SYSTEM_PROMPT } from './prompt';

type GenerateCall = Parameters<MockLanguageModelV4['doGenerate']>[0];

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

const NO_USAGE = {
  inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
};

/** A language model that answers with the given raw text and records the call. */
function mockLlm(text: string, calls: GenerateCall[] = []) {
  return new MockLanguageModelV4({
    provider: 'gateway',
    modelId: 'test/model',
    doGenerate: async (options) => {
      calls.push(options);
      return {
        content: [{ type: 'text' as const, text }],
        finishReason: { unified: 'stop' as const, raw: undefined },
        usage: NO_USAGE,
        warnings: [],
      };
    },
  });
}

describe('parseMove', () => {
  it.each(['up', 'down', 'stay'])('accepts { move: "%s" }', (move) => {
    expect(parseMove({ move })).toBe(move);
  });

  it.each([
    ['a bare string', 'up'],
    ['the wrong key', { direction: 'up' }],
    ['an illegal move', { move: 'left' }],
    ['the wrong case', { move: 'UP' }],
    ['a null', null],
    ['nothing', undefined],
  ])('rejects %s', (_label, value) => {
    expect(() => parseMove(value)).toThrow(/unusable decision/i);
  });

  it('keeps the rejection message short and quotes what came back', () => {
    try {
      parseMove({ move: 'x'.repeat(500) });
      expect.unreachable('parseMove should have thrown');
    } catch (err) {
      expect((err as Error).message.length).toBeLessThan(160);
      expect((err as Error).message).toContain('...');
    }
  });
});

describe('decideWithLlm', () => {
  it('returns the structured move and a measured latency', async () => {
    const result = await decideWithLlm('test/model', state(), {
      modelOverride: mockLlm('{"move":"down"}'),
    });
    expect(result.move).toBe('down');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('sends the shared instructions and the DecisionState, nothing else', async () => {
    const calls: GenerateCall[] = [];
    await decideWithLlm('test/model', state(), { modelOverride: mockLlm('{"move":"up"}', calls) });

    const [call] = calls;
    const text = JSON.stringify(call.prompt);
    expect(text).toContain(LLM_SYSTEM_PROMPT.slice(0, 60));
    expect(text).toContain('"interceptY\\":66');
    expect(call.temperature).toBe(0);
    expect(call.maxOutputTokens).toBe(MAX_OUTPUT_TOKENS);
  });

  it('rejects an answer that is not a legal move', async () => {
    await expect(
      decideWithLlm('test/model', state(), { modelOverride: mockLlm('{"move":"left"}') }),
    ).rejects.toThrow();
  });

  it('never reaches the network in these tests', async () => {
    const calls: GenerateCall[] = [];
    await decideWithLlm('test/model', state(), { modelOverride: mockLlm('{"move":"stay"}', calls) });
    expect(calls).toHaveLength(1);
  });
});

describe('reasoningOff', () => {
  it('disables extended thinking for Anthropic', () => {
    expect(reasoningOff('anthropic/claude-haiku-4.5')).toEqual({
      anthropic: { thinking: { type: 'disabled' } },
    });
  });

  it('zeroes the thinking budget for Google', () => {
    expect(reasoningOff('google/gemini-3.8-flash')).toEqual({
      google: { thinkingConfig: { thinkingBudget: 0 } },
    });
  });

  it('sends nothing for providers with no supported switch', () => {
    expect(reasoningOff('openai/gpt-5.6-sol')).toBeUndefined();
    expect(reasoningOff('somebody/else')).toBeUndefined();
  });
});

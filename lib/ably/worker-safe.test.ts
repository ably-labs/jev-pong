/**
 * The game worker (lib/worker/game-worker.ts, a Vercel invocation kept alive
 * with `after()`) shares a few modules with the browser hooks: the wire shapes
 * in presence.ts, the Coalescer, and the id helpers. That only works while
 * those modules stay free of React and of browser globals, which is easy to
 * break by adding one convenient import.
 *
 * So assert it at the source level, where the mistake is actually visible.
 */

import * as Ably from 'ably';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CHANNELS } from '../game/types';
import { MAX_NAME_LENGTH, asGamePresence, asInputMessage, asSnapshot, sanitiseName } from './presence';

/** Modules the Node worker loads, directly or transitively. */
const WORKER_MODULES = ['coalesce.ts', 'presence.ts', 'ids.ts'] as const;

function source(file: string): string {
  return readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
}

describe('worker-safe modules', () => {
  it.each(WORKER_MODULES)('%s does not import React or ably/react', (file) => {
    const text = source(file);
    expect(text).not.toMatch(/from '(react|ably\/react)'/);
    expect(text).not.toMatch(/^'use client'/m);
  });

  it.each(WORKER_MODULES)('%s does not reach for browser globals', (file) => {
    // Strip comments so prose about the browser does not trip the check.
    const code = source(file)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(code).not.toMatch(/\bwindow\b/);
    expect(code).not.toMatch(/\bdocument\b/);
    expect(code).not.toMatch(/\blocalStorage\b/);
  });

  it('takes a Node Ably.Realtime built from an API key', () => {
    // `autoConnect: false` keeps this off the network. What is under test is
    // that the Node build of the SDK loads at all outside a browser, which is
    // what the worker relies on.
    const client = new Ably.Realtime({
      key: 'jevpong.test:this-is-not-a-real-secret',
      autoConnect: false,
    });

    try {
      expect(client.channels.get(CHANNELS.lobby)).toBeDefined();
      expect(client.channels.get(CHANNELS.game('nodecheck'))).toBeDefined();
    } finally {
      client.close();
    }
  });
});

describe('wire guards', () => {
  it('accepts a well-formed snapshot and rejects junk', () => {
    const good = {
      t: 1,
      tick: 2,
      seed: 3,
      ball: { x: 0, y: 0, vx: 1, vy: 1 },
      leftY: 0,
      rightY: 0,
      score: [0, 0],
      model: 'jev',
      latencyMs: null,
      move: null,
      status: 'playing',
    };

    expect(asSnapshot(good)).not.toBeNull();
    expect(asSnapshot(null)).toBeNull();
    expect(asSnapshot('state')).toBeNull();
    expect(asSnapshot({ ...good, score: [0] })).toBeNull();
    expect(asSnapshot({ ...good, ball: 'nope' })).toBeNull();
    expect(asSnapshot({ ...good, tick: '2' })).toBeNull();
  });

  it('accepts the three game roles and nothing else', () => {
    expect(asGamePresence({ role: 'player' })).toEqual({ role: 'player' });
    expect(asGamePresence({ role: 'agent', model: 'jev', side: 'right' })).toEqual({
      role: 'agent',
      model: 'jev',
      side: 'right',
    });
    expect(asGamePresence({ role: 'spectator', side: 'up' })).toEqual({ role: 'spectator' });
    expect(asGamePresence({ role: 'admin' })).toBeNull();
    expect(asGamePresence({})).toBeNull();
    expect(asGamePresence(undefined)).toBeNull();
  });

  it('keeps a player name, sanitised, and never lets one through raw', () => {
    expect(asGamePresence({ role: 'player', name: 'Matt' })).toEqual({
      role: 'player',
      name: 'Matt',
    });
    // No name is the normal case, and an unusable one is simply absent.
    expect(asGamePresence({ role: 'player' })).toEqual({ role: 'player' });
    expect(asGamePresence({ role: 'player', name: '   ' })).toEqual({ role: 'player' });
    expect(asGamePresence({ role: 'player', name: 42 })).toEqual({ role: 'player' });

    expect(sanitiseName('  two   words  ')).toBe('two words');
    expect(sanitiseName('line\nbreak\tand\u0000nul')).toBe('line break and nul');
    expect(sanitiseName('x'.repeat(100))).toHaveLength(MAX_NAME_LENGTH);
    expect(sanitiseName('')).toBeNull();
    expect(sanitiseName(null)).toBeNull();
  });

  it('accepts only real moves on an input message', () => {
    expect(asInputMessage({ move: 'up' })).toEqual({ move: 'up' });
    expect(asInputMessage({ move: 'stay' })).toEqual({ move: 'stay' });
    expect(asInputMessage({ move: 'jump' })).toBeNull();
    expect(asInputMessage({})).toBeNull();
  });
});

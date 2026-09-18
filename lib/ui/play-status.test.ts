import { describe, expect, it } from 'vitest';
import type { LaneStatus, Snapshot } from '../game/types';
import {
  dealErrorFor,
  endReasonText,
  gameIdFrom,
  playStatus,
  watchStatus,
  type PlayStatusInput,
} from './play-status';

function snap(status: LaneStatus, extra: Partial<Snapshot> = {}): Snapshot {
  return {
    t: 1000,
    tick: 7,
    seed: 1,
    ball: { x: 80, y: 50, vx: 1, vy: 0 },
    leftY: 50,
    rightY: 50,
    score: [0, 0],
    model: 'jev',
    latencyMs: 430,
    move: 'stay',
    status,
    ...extra,
  };
}

const BASE: PlayStatusInput = {
  deal: 'ready',
  dealError: null,
  connection: 'live',
  snapshot: null,
  agentPresent: true,
  opponent: 'Jev',
};

function status(over: Partial<PlayStatusInput>) {
  return playStatus({ ...BASE, ...over });
}

describe('dealErrorFor', () => {
  it('reads the route error code', () => {
    expect(dealErrorFor(503, { error: 'ably_not_configured' })).toBe('ably_not_configured');
    expect(dealErrorFor(429, { error: 'too_many_games' })).toBe('too_many_games');
    expect(dealErrorFor(403, { error: 'model_not_allowed' })).toBe('model_not_allowed');
  });

  it('falls back to the status code when the body says nothing', () => {
    expect(dealErrorFor(503, null)).toBe('ably_not_configured');
    expect(dealErrorFor(429, 'gateway timeout')).toBe('too_many_games');
    expect(dealErrorFor(403, {})).toBe('model_not_allowed');
  });

  it('calls anything else unavailable', () => {
    expect(dealErrorFor(400, { error: 'bad_request' })).toBe('unavailable');
    expect(dealErrorFor(502, { error: 'lobby_unavailable' })).toBe('unavailable');
    expect(dealErrorFor(500, undefined)).toBe('unavailable');
  });
});

describe('gameIdFrom', () => {
  it('takes a non-empty string id', () => {
    expect(gameIdFrom({ gameId: 'bcdfghjk', channel: 'pong:game:bcdfghjk' })).toBe('bcdfghjk');
  });

  it('rejects anything else', () => {
    expect(gameIdFrom({ gameId: '' })).toBeNull();
    expect(gameIdFrom({ gameId: 42 })).toBeNull();
    expect(gameIdFrom({})).toBeNull();
    expect(gameIdFrom(null)).toBeNull();
    expect(gameIdFrom('bcdfghjk')).toBeNull();
  });
});

describe('endReasonText', () => {
  it('names the winner from the score', () => {
    expect(endReasonText('won', [5, 3], 'Jev')).toBe('You won, 5–3.');
    expect(endReasonText('won', [2, 5], 'Jev')).toBe('Jev won, 2–5.');
  });

  it('explains the other reasons the worker sends', () => {
    expect(endReasonText('idle', [0, 0], 'Jev')).toContain('Nobody was playing');
    expect(endReasonText('time_limit', [0, 0], 'Jev')).toContain('time limit');
    expect(endReasonText('player_left', [0, 0], 'Jev')).toContain('left the channel');
    expect(endReasonText('no_player', [0, 0], 'Jev')).toContain('paddle');
    expect(endReasonText('error', [0, 0], 'Jev')).toContain('model call failed');
  });

  it('passes an unknown reason through rather than swallowing it', () => {
    expect(endReasonText('meteor_strike', [0, 0], 'Jev')).toBe('meteor_strike');
  });

  it('has nothing to say without a reason', () => {
    expect(endReasonText(undefined, [0, 0], 'Jev')).toBeNull();
    expect(endReasonText('', [0, 0], 'Jev')).toBeNull();
  });
});

describe('playStatus — before there is a game', () => {
  it('is dealing, with no paddle and no restart', () => {
    const s = status({ deal: 'dealing' });
    expect(s.label).toBe('dealing a game');
    expect(s.presence).toBeNull();
    expect(s.acceptInput).toBe(false);
    expect(s.offerRestart).toBe(false);
  });

  it('explains a 503 as "not configured" and offers a retry', () => {
    const s = status({ deal: 'failed', dealError: 'ably_not_configured' });
    expect(s.label).toBe('not configured');
    expect(s.detail).toContain('no Ably key');
    expect(s.tone).toBe('alarm');
    expect(s.acceptInput).toBe(false);
    expect(s.offerRestart).toBe(true);
  });

  it('explains a 429 as "too many games"', () => {
    const s = status({ deal: 'failed', dealError: 'too_many_games' });
    expect(s.label).toBe('too many games');
    expect(s.detail).toContain('busy');
    expect(s.tone).toBe('alarm');
    expect(s.offerRestart).toBe(true);
  });

  it('treats a failure with no code as simply unavailable', () => {
    expect(status({ deal: 'failed', dealError: null }).label).toBe('could not start a game');
  });
});

describe('playStatus — waiting for the worker', () => {
  it('says it is waiting until the agent enters presence', () => {
    const s = status({ agentPresent: false, connection: 'connecting' });
    expect(s.presence).toBe('Waiting for Jev to join');
    expect(s.tone).toBe('waiting');
  });

  it('says it has joined once the agent is present', () => {
    expect(status({ agentPresent: true }).presence).toBe('Jev joined the channel');
  });

  it('names whoever holds the right paddle', () => {
    expect(status({ agentPresent: false, opponent: 'Gemini 3.8 Flash' }).presence).toBe(
      'Waiting for Gemini 3.8 Flash to join',
    );
  });

  it('does not take input while connecting with no agent', () => {
    expect(status({ agentPresent: false, connection: 'connecting' }).acceptInput).toBe(false);
  });
});

describe('playStatus — a live game', () => {
  it('reports the snapshot status', () => {
    expect(status({ snapshot: snap('serving') }).label).toBe('serving');
    expect(status({ snapshot: snap('playing') }).label).toBe('playing');
    expect(status({ snapshot: snap('point') }).label).toBe('point');
    expect(status({ snapshot: snap('idle') }).label).toBe('ready');
  });

  it('takes input and is live', () => {
    const s = status({ snapshot: snap('playing') });
    expect(s.acceptInput).toBe(true);
    expect(s.tone).toBe('live');
    expect(s.offerRestart).toBe(false);
  });

  it('stays quiet before the first snapshot', () => {
    const s = status({ snapshot: null, connection: 'live' });
    expect(s.label).toBe('waiting for the first move');
    expect(s.acceptInput).toBe(true);
  });
});

describe('playStatus — a game that has stopped', () => {
  it('shows game over with the worker reason', () => {
    const s = status({
      connection: 'ended',
      snapshot: snap('over', { message: 'won', score: [5, 2] }),
    });
    expect(s.label).toBe('game over');
    expect(s.detail).toBe('You won, 5–2.');
    expect(s.acceptInput).toBe(false);
    expect(s.offerRestart).toBe(true);
  });

  it('shows out of credits with the message as the detail', () => {
    const s = status({
      connection: 'ended',
      snapshot: snap('credits', { message: 'AI Gateway credits exhausted' }),
    });
    expect(s.label).toBe('out of credits');
    expect(s.detail).toBe('AI Gateway credits exhausted');
    expect(s.tone).toBe('alarm');
    expect(s.offerRestart).toBe(true);
  });

  it('shows an engine error with its message', () => {
    const s = status({ connection: 'ended', snapshot: snap('error', { message: 'model_error' }) });
    expect(s.label).toBe('error');
    expect(s.detail).toBe('model_error');
    expect(s.tone).toBe('alarm');
  });

  it('prefers the finished game over a dead channel', () => {
    const s = status({
      connection: 'error',
      snapshot: snap('over', { message: 'won', score: [5, 4] }),
    });
    expect(s.label).toBe('game over');
  });

  it('reports a channel it could never join', () => {
    const s = status({ connection: 'error', snapshot: null, agentPresent: false });
    expect(s.label).toBe('could not join the game');
    expect(s.tone).toBe('alarm');
    expect(s.acceptInput).toBe(false);
    expect(s.offerRestart).toBe(true);
  });
});

describe('watchStatus', () => {
  const snapshot = (over: Partial<Snapshot> = {}): Snapshot => ({
    t: 1000,
    tick: 4,
    seed: 1,
    ball: { x: 80, y: 50, vx: 26.6, vy: 2 },
    leftY: 50,
    rightY: 50,
    score: [2, 4],
    model: 'jev',
    latencyMs: 420,
    move: 'stay',
    status: 'playing',
    ...over,
  });

  it('is connecting until the first snapshot arrives', () => {
    expect(watchStatus('connecting', null, 'Jev', 'anon-4c2f')).toEqual({
      tone: 'connecting',
      label: 'Connecting…',
    });
  });

  it('is live once a snapshot is on the wire', () => {
    expect(watchStatus('live', snapshot(), 'Jev', 'anon-4c2f')).toEqual({
      tone: 'live',
      label: 'Live',
    });
    // A snapshot outranks a channel that still says "connecting".
    expect(watchStatus('connecting', snapshot(), 'Jev', 'anon-4c2f').tone).toBe('live');
  });

  it('names the winner when the game was won', () => {
    const won = snapshot({ status: 'over', message: 'won', score: [3, 7] });
    expect(watchStatus('ended', won, 'Jev', 'anon-4c2f').label).toBe('Ended · Jev won 7–3');
    const byPlayer = snapshot({ status: 'over', message: 'won', score: [7, 3] });
    expect(watchStatus('ended', byPlayer, 'Jev', 'anon-4c2f').label).toBe(
      'Ended · anon-4c2f won 7–3',
    );
  });

  it('gives the reason for every other ending', () => {
    expect(watchStatus('ended', snapshot({ status: 'credits' }), 'Jev', 'anon-4c2f').label).toBe(
      'Ended · out of credits',
    );
    expect(
      watchStatus('ended', snapshot({ status: 'over', message: 'player_left' }), 'Jev', 'anon-4c2f')
        .label,
    ).toBe('Ended · anon-4c2f left');
    expect(watchStatus('ended', snapshot({ status: 'over', message: 'idle' }), 'Jev', 'a').label).toBe(
      'Ended · game over',
    );
    expect(watchStatus('error', null, 'Jev', 'anon-4c2f')).toEqual({
      tone: 'ended',
      label: 'Ended · channel unreachable',
    });
  });
});

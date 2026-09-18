import { describe, expect, it } from 'vitest';
import {
  agentName,
  anonForGame,
  anonName,
  channelLabel,
  CONNECTING,
  displayName,
  feedTextFor,
  formatElapsed,
} from './feed';

describe('names', () => {
  it('takes the last four characters of the client id', () => {
    expect(anonName('pong-4f3ac2be1d')).toBe('anon-be1d');
    expect(anonName('4c2f')).toBe('anon-4c2f');
    expect(anonName(null)).toBe('anon-????');
    expect(anonName('')).toBe('anon-????');
  });

  it('labels the channel by the tail of the game id', () => {
    expect(channelLabel('mn4gq7c2')).toBe('game:q7c2');
    expect(channelLabel('abcd1234')).toBe('game:1234');
  });

  it('names a lobby game after the channel it is on', () => {
    // The lobby never sees the player's own client id, only the game.
    expect(anonForGame('abcd4c2f')).toBe('anon-4c2f');
  });

  it('prettifies a model id the build knows, and passes on one it does not', () => {
    expect(agentName('jev')).toBe('Jev');
    expect(agentName('haiku')).toBe('Claude Haiku 4.5');
    expect(agentName('something-new')).toBe('something-new');
    expect(agentName(undefined)).toBe('The agent');
  });
});

describe('formatElapsed', () => {
  it('is mm:ss from when the page mounted', () => {
    expect(formatElapsed(0)).toBe('0:00');
    expect(formatElapsed(999)).toBe('0:00');
    expect(formatElapsed(12_400)).toBe('0:12');
    expect(formatElapsed(61_000)).toBe('1:01');
    expect(formatElapsed(-500)).toBe('0:00');
  });
});

describe('feedTextFor', () => {
  it('reads the presence set the way the artboard writes it', () => {
    expect(feedTextFor({ role: 'player' }, 'pong-4c2f', true, false)).toEqual({
      text: 'you joined',
      kind: 'you',
    });
    expect(feedTextFor({ role: 'agent', model: 'jev' }, 'agent:jev:x', false, false)).toEqual({
      text: 'Jev joined',
      kind: 'agent',
    });
    expect(feedTextFor({ role: 'spectator' }, 'pong-91be', false, false)).toEqual({
      text: 'anon-91be is watching',
      kind: 'watcher',
    });
    expect(feedTextFor({ role: 'spectator' }, 'pong-91be', true, false)).toEqual({
      text: 'you are watching',
      kind: 'you',
    });
    expect(feedTextFor({ role: 'player' }, 'pong-91be', false, false)).toEqual({
      text: 'anon-91be joined',
      kind: 'player',
    });
  });

  it('says who left', () => {
    expect(feedTextFor({ role: 'spectator' }, 'pong-91be', false, true)).toEqual({
      text: 'anon-91be left',
      kind: 'left',
    });
    expect(feedTextFor({ role: 'agent', model: 'jev' }, 'agent', false, true)).toEqual({
      text: 'Jev left',
      kind: 'left',
    });
  });
});

describe('displayName', () => {
  it('prefers the name the player typed', () => {
    expect(displayName('pong-4c2f', 'Matt')).toBe('Matt');
    expect(displayName(null, 'Matt')).toBe('Matt');
  });

  it('falls back to the anon name once there is a client id', () => {
    expect(displayName('pong-4c2f')).toBe('anon-4c2f');
    expect(displayName('pong-4c2f', '')).toBe('anon-4c2f');
  });

  it('never guesses a name it does not have yet', () => {
    expect(displayName(null)).toBe(CONNECTING);
    expect(displayName(undefined, null)).toBe(CONNECTING);
  });
});

describe('feedTextFor with a name', () => {
  it('uses the name wherever anon-XXXX would have been', () => {
    expect(feedTextFor({ role: 'player' }, 'pong-91be', false, false, 'Matt')).toEqual({
      text: 'Matt joined',
      kind: 'player',
    });
    expect(feedTextFor({ role: 'player' }, 'pong-4c2f', true, false, 'Matt')).toEqual({
      text: 'Matt joined',
      kind: 'you',
    });
    expect(feedTextFor({ role: 'player' }, 'pong-91be', false, true, 'Matt')).toEqual({
      text: 'Matt left',
      kind: 'left',
    });
  });

  it('leaves the agent alone', () => {
    expect(feedTextFor({ role: 'agent', model: 'jev' }, 'agent', false, false, 'Matt')).toEqual({
      text: 'Jev joined',
      kind: 'agent',
    });
  });
});

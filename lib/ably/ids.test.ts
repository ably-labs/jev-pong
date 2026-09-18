import { describe, expect, it } from 'vitest';
import {
  CLIENT_ID_MAX_LENGTH,
  CLIENT_ID_PATTERN,
  GAME_ID_LENGTH,
  isValidClientId,
  newClientId,
  newGameId,
} from './ids';

describe('newGameId', () => {
  it('is 8 url-safe characters', () => {
    for (let i = 0; i < 200; i += 1) {
      const id = newGameId();
      expect(id).toHaveLength(GAME_ID_LENGTH);
      expect(id).toMatch(/^[a-z0-9]{8}$/);
    }
  });

  it('does not repeat itself', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i += 1) seen.add(newGameId());
    expect(seen.size).toBe(2000);
  });
});

describe('newClientId', () => {
  it('always satisfies the accepted client-id pattern', () => {
    for (let i = 0; i < 200; i += 1) {
      const id = newClientId();
      expect(isValidClientId(id)).toBe(true);
      expect(id.length).toBeLessThanOrEqual(CLIENT_ID_MAX_LENGTH);
    }
  });
});

describe('isValidClientId', () => {
  it.each(['a', 'spectator-1', 'Matt_2', 'pong-abcdef1234', 'A'.repeat(CLIENT_ID_MAX_LENGTH)])(
    'accepts %s',
    (value) => {
      expect(isValidClientId(value)).toBe(true);
    },
  );

  it.each([
    ['empty', ''],
    ['too long', 'a'.repeat(CLIENT_ID_MAX_LENGTH + 1)],
    ['a space', 'has space'],
    ['a wildcard', 'bad*'],
    ['a colon', 'app.key:secret'],
    ['a slash', 'a/b'],
    ['an embedded newline', 'ok\nnot'],
    ['a trailing newline', 'spectator\n'],
    ['non-ascii', 'café'],
  ])('rejects %s', (_label, value) => {
    expect(isValidClientId(value)).toBe(false);
  });

  it('is anchored at both ends, so a valid substring is not enough', () => {
    expect(CLIENT_ID_PATTERN.test('good\nbad')).toBe(false);
    expect(CLIENT_ID_PATTERN.test('good\n')).toBe(false);
  });
});

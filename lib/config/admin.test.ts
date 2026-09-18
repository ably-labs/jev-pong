import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ADMIN_TOKEN_HEADER,
  ADMIN_TOKEN_STORAGE_KEY,
  adminHeaders,
  hasAdminAccess,
  isAdminRequest,
  readAdminToken,
  storeAdminToken,
} from './admin';

const URL_BASE = 'https://jev-pong.example/api/game';

function request(url = URL_BASE, headers: Record<string, string> = {}): Request {
  return new Request(url, { headers });
}

/** A localStorage good enough for these tests. */
function fakeStorage(initial: Record<string, string> = {}): Storage {
  const map = new Map<string, string>(Object.entries(initial));
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => {
      map.delete(key);
    },
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
}

function withWindow(storage: Storage | (() => never)): void {
  vi.stubGlobal('window', {
    get localStorage() {
      if (typeof storage === 'function') return storage();
      return storage;
    },
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('isAdminRequest — outside production', () => {
  it('lets anything through with no token configured', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('ADMIN_TOKEN', '');
    expect(isAdminRequest(request())).toBe(true);
  });

  it('does not require the token even when one is set', () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('ADMIN_TOKEN', 'sekrit');
    expect(isAdminRequest(request())).toBe(true);
  });
});

describe('isAdminRequest — in production', () => {
  it('refuses when no token is configured', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('ADMIN_TOKEN', '');
    expect(isAdminRequest(request(URL_BASE, { [ADMIN_TOKEN_HEADER]: 'anything' }))).toBe(false);
  });

  it('refuses an unset ADMIN_TOKEN even against an empty header', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.unstubAllEnvs();
    vi.stubEnv('NODE_ENV', 'production');
    expect(isAdminRequest(request(URL_BASE, { [ADMIN_TOKEN_HEADER]: '' }))).toBe(false);
  });

  it('accepts the matching header', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('ADMIN_TOKEN', 'sekrit');
    expect(isAdminRequest(request(URL_BASE, { [ADMIN_TOKEN_HEADER]: 'sekrit' }))).toBe(true);
  });

  it('rejects a wrong header', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('ADMIN_TOKEN', 'sekrit');
    // Short, same length but a different byte, and a case difference.
    expect(isAdminRequest(request(URL_BASE, { [ADMIN_TOKEN_HEADER]: 'sekri' }))).toBe(false);
    expect(isAdminRequest(request(URL_BASE, { [ADMIN_TOKEN_HEADER]: 'sekrjt' }))).toBe(false);
    expect(isAdminRequest(request(URL_BASE, { [ADMIN_TOKEN_HEADER]: 'SEKRIT' }))).toBe(false);
  });

  it('accepts a header the platform has trimmed, because HTTP trims it', () => {
    // Headers strips surrounding whitespace before we ever see the value, so
    // "sekrit " arrives as "sekrit". Asserting anything else would be a test
    // about a value that cannot reach the function.
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('ADMIN_TOKEN', 'sekrit');
    const req = request(URL_BASE, { [ADMIN_TOKEN_HEADER]: ' sekrit ' });
    expect(req.headers.get(ADMIN_TOKEN_HEADER)).toBe('sekrit');
    expect(isAdminRequest(req)).toBe(true);
  });

  it('accepts the matching ?token= query parameter', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('ADMIN_TOKEN', 'sekrit');
    expect(isAdminRequest(request(`${URL_BASE}?token=sekrit`))).toBe(true);
  });

  it('rejects a wrong ?token=', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('ADMIN_TOKEN', 'sekrit');
    expect(isAdminRequest(request(`${URL_BASE}?token=nope`))).toBe(false);
  });

  it('rejects a request carrying neither', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('ADMIN_TOKEN', 'sekrit');
    expect(isAdminRequest(request())).toBe(false);
  });

  it('takes the header when the query is wrong, and vice versa', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('ADMIN_TOKEN', 'sekrit');
    expect(
      isAdminRequest(request(`${URL_BASE}?token=nope`, { [ADMIN_TOKEN_HEADER]: 'sekrit' })),
    ).toBe(true);
    expect(
      isAdminRequest(request(`${URL_BASE}?token=sekrit`, { [ADMIN_TOKEN_HEADER]: 'nope' })),
    ).toBe(true);
  });
});

describe('browser token storage', () => {
  it('reads nothing on a server', () => {
    expect(readAdminToken()).toBeNull();
    expect(adminHeaders()).toEqual({});
  });

  it('reads a stored token and turns it into a header', () => {
    withWindow(fakeStorage({ [ADMIN_TOKEN_STORAGE_KEY]: 'sekrit' }));
    expect(readAdminToken()).toBe('sekrit');
    expect(adminHeaders()).toEqual({ [ADMIN_TOKEN_HEADER]: 'sekrit' });
  });

  it('treats an empty stored value as absent', () => {
    withWindow(fakeStorage({ [ADMIN_TOKEN_STORAGE_KEY]: '' }));
    expect(readAdminToken()).toBeNull();
    expect(adminHeaders()).toEqual({});
  });

  it('stores and clears', () => {
    const store = fakeStorage();
    withWindow(store);
    storeAdminToken('sekrit');
    expect(store.getItem(ADMIN_TOKEN_STORAGE_KEY)).toBe('sekrit');
    storeAdminToken('');
    expect(store.getItem(ADMIN_TOKEN_STORAGE_KEY)).toBeNull();
  });

  it('survives a browser that throws on localStorage', () => {
    withWindow(() => {
      throw new Error('blocked');
    });
    expect(readAdminToken()).toBeNull();
    expect(adminHeaders()).toEqual({});
    expect(() => storeAdminToken('sekrit')).not.toThrow();
  });
});

describe('hasAdminAccess', () => {
  it('is true outside production without a token', () => {
    vi.stubEnv('NODE_ENV', 'development');
    expect(hasAdminAccess()).toBe(true);
  });

  it('needs a stored token in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    withWindow(fakeStorage());
    expect(hasAdminAccess()).toBe(false);
    withWindow(fakeStorage({ [ADMIN_TOKEN_STORAGE_KEY]: 'sekrit' }));
    expect(hasAdminAccess()).toBe(true);
  });
});

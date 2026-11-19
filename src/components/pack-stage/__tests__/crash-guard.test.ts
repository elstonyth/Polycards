import { describe, expect, it, vi } from 'vitest';

import {
  STAGE_CRASH_KEY,
  STAGE_STABLE_MS,
  armBootGuard,
  clearBooting,
  markBooting,
  markCrashed,
  readCrashFlag,
  type CrashStorage,
} from '../crash-guard';

function memoryStorage(): CrashStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

const throwing: CrashStorage = {
  getItem: () => {
    throw new Error('SecurityError');
  },
  setItem: () => {
    throw new Error('QuotaExceededError');
  },
  removeItem: () => {
    throw new Error('SecurityError');
  },
};

function fakeTarget() {
  const handlers = new Map<string, Set<() => void>>();
  return {
    addEventListener: (t: string, fn: () => void) => {
      if (!handlers.has(t)) handlers.set(t, new Set());
      handlers.get(t)?.add(fn);
    },
    removeEventListener: (t: string, fn: () => void) => {
      handlers.get(t)?.delete(fn);
    },
    fire: (t: string) => {
      for (const fn of [...(handlers.get(t) ?? [])]) fn();
    },
    count: (t: string) => handlers.get(t)?.size ?? 0,
  } as unknown as Pick<Window, 'addEventListener' | 'removeEventListener'> & {
    fire(t: string): void;
    count(t: string): number;
  };
}

describe('crash-guard flags', () => {
  it('reads nothing on a clean session', () => {
    expect(readCrashFlag(memoryStorage())).toBe(false);
  });

  it('a boot flag found at boot means the last attempt died', () => {
    const s = memoryStorage();
    markBooting(s);
    expect(s.map.get(STAGE_CRASH_KEY)).toBe('boot');
    expect(readCrashFlag(s)).toBe(true);
    clearBooting(s);
    expect(readCrashFlag(s)).toBe(false);
  });

  it('a crash flag is never cleared by the boot path', () => {
    const s = memoryStorage();
    markCrashed(s);
    clearBooting(s);
    expect(readCrashFlag(s)).toBe(true);
    expect(s.map.get(STAGE_CRASH_KEY)).toBe('crashed');
  });

  it('throwing or missing storage reads as no flag and writes nothing', () => {
    expect(readCrashFlag(throwing)).toBe(false);
    expect(() => markBooting(throwing)).not.toThrow();
    expect(() => markCrashed(throwing)).not.toThrow();
    expect(() => clearBooting(throwing)).not.toThrow();
    expect(readCrashFlag(null)).toBe(false);
    expect(() => markBooting(null)).not.toThrow();
  });
});

describe('armBootGuard', () => {
  it('sets the flag, then clears it after 5 s stable', () => {
    vi.useFakeTimers();
    try {
      const s = memoryStorage();
      const target = fakeTarget();
      armBootGuard({ storage: s, target });
      expect(s.map.get(STAGE_CRASH_KEY)).toBe('boot');
      vi.advanceTimersByTime(STAGE_STABLE_MS - 1);
      expect(readCrashFlag(s)).toBe(true);
      vi.advanceTimersByTime(1);
      expect(readCrashFlag(s)).toBe(false);
      expect(target.count('pagehide')).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the flag on pagehide', () => {
    vi.useFakeTimers();
    try {
      const s = memoryStorage();
      const target = fakeTarget();
      armBootGuard({ storage: s, target });
      target.fire('pagehide');
      expect(readCrashFlag(s)).toBe(false);
      expect(target.count('pagehide')).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves the flag when the tab dies before either (no timer, no pagehide)', () => {
    const s = memoryStorage();
    armBootGuard({
      storage: s,
      target: fakeTarget(),
      setTimer: () => 0,
      clearTimer: () => {},
    });
    expect(readCrashFlag(s)).toBe(true);
  });

  it('cancel keeps the flag (a crash marks it instead); a later crash wins over pagehide', () => {
    const s = memoryStorage();
    const target = fakeTarget();
    const g = armBootGuard({
      storage: s,
      target,
      setTimer: () => 0,
      clearTimer: () => {},
    });
    g.cancel();
    markCrashed(s);
    target.fire('pagehide');
    expect(s.map.get(STAGE_CRASH_KEY)).toBe('crashed');
  });

  it('works with throwing storage', () => {
    const target = fakeTarget();
    expect(() =>
      armBootGuard({ storage: throwing, target }).settle(),
    ).not.toThrow();
  });
});

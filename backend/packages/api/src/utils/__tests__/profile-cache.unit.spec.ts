import {
  clearProfileCache,
  getCachedProfile,
  profileCacheSize,
  setCachedProfile,
} from '../profile-cache';

// Audit 2026-11-11: the Map only shed an entry when that same handle was read
// again after expiry, so walking every handle grew it without bound.

describe('profile cache bound', () => {
  afterEach(() => {
    jest.useRealTimers();
    clearProfileCache();
  });

  it('never holds more than 500 bodies, dropping the oldest first', () => {
    for (let i = 0; i < 2_000; i++) setCachedProfile(`h${i}`, { i });
    expect(profileCacheSize()).toBe(500);
    expect(getCachedProfile('h0')).toBeUndefined();
    expect(getCachedProfile('h1499')).toBeUndefined();
    expect(getCachedProfile('h1500')).toEqual({ i: 1500 });
    expect(getCachedProfile('h1999')).toEqual({ i: 1999 });
  });

  it('sweeps expired bodies before dropping a live one', () => {
    jest.useFakeTimers();
    for (let i = 0; i < 499; i++) setCachedProfile(`old${i}`, i);
    setCachedProfile('live', 'keep');
    jest.advanceTimersByTime(20_000);
    // 'live' was written 20s ago and is still fresh; refresh it so only the
    // 499 old ones expire at the 31s mark.
    setCachedProfile('live', 'keep');
    jest.advanceTimersByTime(11_000);
    setCachedProfile('new', 'n');
    expect(profileCacheSize()).toBe(2);
    expect(getCachedProfile('live')).toBe('keep');
    expect(getCachedProfile('new')).toBe('n');
  });

  it('re-setting a handle refreshes it in place, not as a second entry', () => {
    setCachedProfile('a', 1);
    setCachedProfile('a', 2);
    expect(profileCacheSize()).toBe(1);
    expect(getCachedProfile('a')).toBe(2);
  });
});

import { InMemoryPresenceStore, ONLINE_WINDOW_MS } from '../presence';

const T0 = Date.parse('2026-10-15T08:00:00Z');

describe('InMemoryPresenceStore', () => {
  it('lists who was seen since a moment, by their latest ping', async () => {
    const store = new InMemoryPresenceStore();
    await store.touch('cus_a', T0);
    await store.touch('cus_b', T0 + 60_000);
    // A second ping moves A forward; it is still one player.
    await store.touch('cus_a', T0 + 120_000);
    expect((await store.seenSince(T0 + 60_000)).sort()).toEqual([
      'cus_a',
      'cus_b',
    ]);
    expect(await store.seenSince(T0 + 90_000)).toEqual(['cus_a']);
  });

  it('counts a ping exactly on the cutoff as online', async () => {
    const store = new InMemoryPresenceStore();
    await store.touch('cus_a', T0);
    expect(await store.seenSince(T0)).toEqual(['cus_a']);
    expect(await store.seenSince(T0 + 1)).toEqual([]);
  });

  // Every ping lands here for the life of the process: pings older than a
  // day are dropped as new ones arrive, so the map cannot grow without bound.
  it('forgets players last seen more than a day ago', async () => {
    const store = new InMemoryPresenceStore();
    await store.touch('cus_old', T0);
    await store.touch('cus_new', T0 + 25 * 60 * 60_000);
    expect(store.size()).toBe(1);
    expect(await store.seenSince(0)).toEqual(['cus_new']);
  });

  it('online means a ping in the last 5 minutes', () => {
    expect(ONLINE_WINDOW_MS).toBe(5 * 60_000);
  });
});

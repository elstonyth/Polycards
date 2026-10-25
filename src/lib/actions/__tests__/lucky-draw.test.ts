import { afterEach, describe, it, expect, vi } from 'vitest';
import { storeShim, backend } from '@/lib/__tests__/store-shim';

// The real port pipeline runs over an in-memory backend
// (src/lib/__tests__/store-shim.ts); only the network is fake.
vi.mock('@/lib/store', () => ({ store: storeShim }));

import { enterLuckyDraw, getLuckyDrawLive } from '../lucky-draw';

const ENTER = 'POST /store/lucky-draw/prizes/:id/enter';
// Entries are final, so a failure that may have committed must not invite a
// second tap that would spend the tickets again.
const REFRESH = 'Something went wrong — refresh to see your tickets.';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('enterLuckyDraw', () => {
  it('an accepted entry hands back the new balance', async () => {
    const mem = backend({
      [ENTER]: { body: { entered: true, balance: 70, myTickets: 30 } },
    });
    expect(await enterLuckyDraw('ldpz_1', 30)).toEqual({
      ok: true,
      entered: true,
      balance: 70,
      myTickets: 30,
    });
    expect(mem.requests[0]).toMatchObject({
      path: '/store/lucky-draw/prizes/ldpz_1/enter',
      body: { tickets: 30 },
    });
  });

  it('logged out: asks for a login without calling the backend', async () => {
    const mem = backend({}, { token: null });
    expect(await enterLuckyDraw('ldpz_1', 5)).toEqual({
      ok: false,
      error: 'Please log in first.',
    });
    expect(mem.requests).toEqual([]);
  });

  it.each([500, 502, 503, 504])(
    'a %i may have committed: refresh, never "try again"',
    async (status) => {
      backend({ [ENTER]: { status } });
      expect(await enterLuckyDraw('ldpz_1', 5)).toEqual({
        ok: false,
        error: REFRESH,
      });
    },
  );

  it('a failure with no response (timeout, dropped socket) says refresh too', async () => {
    backend({});
    vi.spyOn(storeShim, 'post').mockResolvedValue({
      ok: false,
      kind: 'backend',
      text: 'fetch failed',
    });
    expect(await enterLuckyDraw('ldpz_1', 5)).toEqual({
      ok: false,
      error: REFRESH,
    });
  });

  it('an unreadable 2xx says refresh', async () => {
    backend({ [ENTER]: { body: { nope: true } } });
    expect(await enterLuckyDraw('ldpz_1', 5)).toEqual({
      ok: false,
      error: REFRESH,
    });
  });

  it('a 4xx was refused before anything was spent: its own sentence', async () => {
    backend({ [ENTER]: { status: 400 } });
    expect(await enterLuckyDraw('ldpz_1', 5)).toEqual({
      ok: false,
      error: 'Choose a whole number of tickets you have.',
    });
    backend({ [ENTER]: { status: 429 } });
    expect(await enterLuckyDraw('ldpz_1', 5)).toEqual({
      ok: false,
      error: 'Too many tries — wait a moment and try again.',
    });
    backend({ [ENTER]: { status: 403 } });
    expect(await enterLuckyDraw('ldpz_1', 5)).toEqual({
      ok: false,
      error: 'Could not enter. Please try again.',
    });
  });
});

describe('getLuckyDrawLive', () => {
  const STATUS = 'GET /store/lucky-draw-status';

  // Public: the Games sheet asks for signed-out visitors too.
  it('answers for a visitor with no session', async () => {
    backend({ [STATUS]: { body: { live: false } } }, { token: null });
    expect(await getLuckyDrawLive()).toBe(false);
  });

  it('answers true while an event is on', async () => {
    backend({ [STATUS]: { body: { live: true } } });
    expect(await getLuckyDrawLive()).toBe(true);
  });

  it('is null when the backend fails, so the sheet keeps the tile', async () => {
    backend({ [STATUS]: { status: 500, body: {} } });
    expect(await getLuckyDrawLive()).toBeNull();
  });
});

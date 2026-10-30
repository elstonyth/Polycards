import { afterEach, describe, it, expect, vi } from 'vitest';
import { storeShim, backend } from '@/lib/__tests__/store-shim';

// The real port pipeline runs over an in-memory backend
// (src/lib/__tests__/store-shim.ts); only the network is fake.
vi.mock('@/lib/store', () => ({ store: storeShim }));

import {
  enterLuckyDraw,
  enterLuckyDrawEvent,
  getLuckyDrawEventResult,
  getLuckyDrawLive,
} from '../lucky-draw';

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

describe('enterLuckyDrawEvent', () => {
  const ENTER_EVENT = 'POST /store/lucky-draw/events/:id/enter';

  it('posts the tickets to the event and hands back the new balance', async () => {
    const mem = backend({
      [ENTER_EVENT]: { body: { entered: true, balance: 70, myTickets: 30 } },
    });
    expect(await enterLuckyDrawEvent('ldev_1', 30)).toEqual({
      ok: true,
      entered: true,
      balance: 70,
      myTickets: 30,
    });
    expect(mem.requests[0]).toMatchObject({
      path: '/store/lucky-draw/events/ldev_1/enter',
      body: { tickets: 30 },
    });
  });

  it.each([
    'not_found',
    'not_open',
    'closed',
    'no_topup',
    'not_enough_tickets',
  ])('hands back the %s refusal', async (reason) => {
    backend({ [ENTER_EVENT]: { body: { entered: false, reason } } });
    expect(await enterLuckyDrawEvent('ldev_1', 5)).toEqual({
      ok: true,
      entered: false,
      reason,
    });
  });

  it('a 5xx may have committed: refresh, never "try again"', async () => {
    backend({ [ENTER_EVENT]: { status: 502 } });
    expect(await enterLuckyDrawEvent('ldev_1', 5)).toEqual({
      ok: false,
      error: REFRESH,
    });
  });

  it('a 4xx was refused before anything was spent: its own sentence', async () => {
    backend({ [ENTER_EVENT]: { status: 429 } });
    expect(await enterLuckyDrawEvent('ldev_1', 5)).toEqual({
      ok: false,
      error: 'Too many tries — wait a moment and try again.',
    });
  });

  it('logged out: asks for a login without calling the backend', async () => {
    const mem = backend({}, { token: null });
    expect(await enterLuckyDrawEvent('ldev_1', 5)).toEqual({
      ok: false,
      error: 'Please log in first.',
    });
    expect(mem.requests).toEqual([]);
  });
});

describe('getLuckyDrawEventResult', () => {
  const DETAIL = 'GET /store/lucky-draw/results/events/:eventId';
  const person = {
    who: 'Mimo',
    face_seed: null,
    avatar_url: null,
    frame_url: null,
  };

  it('reads the event as a result the wheel knows', async () => {
    const mem = backend({
      [DETAIL]: {
        body: {
          result: {
            winner: person,
            winner_tickets: 40,
            total_tickets: 40,
            entrant_count: 1,
            seed: 'c',
            seed_hash: 'd',
            drawn_at: '2026-11-30T16:00:00.000Z',
          },
          prizes: [
            { kind: 'card', title: 'Umbreon', image: '/u.webp', value_myr: 42 },
          ],
          entries: [{ person, tickets: 40 }],
          ticket_index: 3,
        },
      },
    });
    const d = await getLuckyDrawEventResult('ldev_1', 'November');
    expect(mem.requests[0]?.path).toBe(
      '/store/lucky-draw/results/events/ldev_1',
    );
    expect(d?.result).toMatchObject({
      prize_id: 'ldev_1',
      title: 'November',
      image: '/u.webp',
      value_myr: 42,
    });
    expect(d?.ticket_index).toBe(3);
  });

  it('is null until the event is drawn (a 404)', async () => {
    backend({ [DETAIL]: { status: 404 } });
    expect(await getLuckyDrawEventResult('ldev_1', 'November')).toBeNull();
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

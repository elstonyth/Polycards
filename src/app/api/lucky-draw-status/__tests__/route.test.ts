import { beforeEach, describe, expect, test, vi } from 'vitest';
import { clearTtlCache } from '@/lib/ttl-cache';
import { LuckyDrawChromeStatusSchema, parseOne } from '@/lib/data/schemas';

// Every signed-in tab reads this about once a minute, so what matters is that the
// tabs share one backend read, and that a blip isn't remembered as "no gates".
const state = vi.hoisted(() => ({
  gets: 0,
  answer: {} as { ok: boolean; data?: unknown },
}));

vi.mock('@/lib/store', () => ({
  store: {
    get: async () => {
      state.gets++;
      return state.answer;
    },
  },
}));

const { GET } = await import('../route');

beforeEach(() => {
  clearTtlCache();
  state.gets = 0;
});

describe('GET /api/lucky-draw-status', () => {
  const live = {
    live: true,
    latest_gate_at: '2026-11-01T00:00:00.000Z',
    upcoming: [{ id: 'g1', ends_at: '2026-11-01T01:00:00.000Z' }],
  };

  test('hands the chrome the dot and the gates to watch', async () => {
    state.answer = { ok: true, data: live };
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      latest_gate_at: live.latest_gate_at,
      upcoming: live.upcoming,
    });
  });

  test('many tabs in a window share one backend read', async () => {
    state.answer = { ok: true, data: live };
    await Promise.all([GET(), GET(), GET(), GET()]);
    await GET();
    expect(state.gets).toBe(1);
  });

  test('a backend still deploying has no gates: nothing to watch, no crash', async () => {
    state.answer = { ok: true, data: { live: false } };
    const body = await (await GET()).json();
    expect(body).toEqual({ latest_gate_at: null, upcoming: [] });
  });

  test('a failed read is a 503 and is not remembered', async () => {
    state.answer = { ok: false };
    expect((await GET()).status).toBe(503);
    state.answer = { ok: true, data: live };
    expect((await GET()).status).toBe(200);
    expect(state.gets).toBe(2);
  });
});

describe('LuckyDrawChromeStatusSchema', () => {
  test('a junk row drops, the good ones stay', () => {
    expect(
      parseOne(LuckyDrawChromeStatusSchema, {
        latest_gate_at: null,
        upcoming: [{ id: 'g1', ends_at: 'x' }, { nope: true }],
      })?.upcoming,
    ).toEqual([{ id: 'g1', ends_at: 'x' }]);
  });
});

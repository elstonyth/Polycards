// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// The one owner of "a draw just landed": who sees the popup, when it reads the
// backend, and when it must stay out of the way. The arena itself is stubbed.

type Detail = {
  result: { prize_id: string; drawn_at: string };
  ticket_index: number | null;
};

const state = vi.hoisted(() => ({
  customer: { id: 'cus_1' } as { id: string } | null,
  consent: 'accepted' as string | null,
  pathname: '/',
  upcoming: [] as { id: string; ends_at: string }[],
  results: new Map<string, unknown>(),
  reads: [] as string[],
  throwing: new Set<string>(),
}));

vi.mock('next/navigation', () => ({ usePathname: () => state.pathname }));
vi.mock('@/components/auth/AuthProvider', () => ({
  useAuth: () => ({ customer: state.customer }),
}));
vi.mock('@/lib/use-consent', () => ({ useConsent: () => state.consent }));
vi.mock('@/lib/lucky-draw-status-read', () => ({
  readLuckyDrawStatus: async () => ({
    latest_gate_at: null,
    upcoming: state.upcoming,
  }),
}));
vi.mock('@/lib/actions/lucky-draw', () => ({
  getLuckyDrawEventResult: async (id: string) => {
    state.reads.push(id);
    return state.results.get(id) ?? null;
  },
}));
vi.mock('@/components/draw-arena/lazy', async () => {
  const { createElement: h } = await import('react');
  return {
    ArenaShow: (p: {
      detail: Detail;
      live: boolean;
      expanded: boolean;
      onClose: () => void;
      onExpand: () => void;
    }) => {
      if (state.throwing.has(p.detail.result.prize_id)) throw new Error('boom');
      return h(
        'div',
        {
          'data-show': p.detail.result.prize_id,
          'data-live': String(p.live),
          'data-expanded': String(p.expanded),
        },
        h('button', { 'data-close': true, onClick: p.onClose }),
        h('button', { 'data-open': true, onClick: p.onExpand }),
      );
    },
  };
});

const { LiveDrawProvider, useLiveDraw } = await import('../LiveDrawProvider');
const { BATCH_WAIT_MS, LIVE_MAX_AGE_MS } =
  await import('@/lib/lucky-draw-watch');

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const MIN = 60_000;
const START = Date.parse('2026-11-01T12:00:30.000Z');
const found = (id: string, ticket: number | null = 3): Detail => ({
  result: { prize_id: id, drawn_at: new Date(Date.now()).toISOString() },
  ticket_index: ticket,
});

let container: HTMLDivElement;
let root: Root;
let seen: ReturnType<typeof useLiveDraw>;

function Probe() {
  const live = useLiveDraw();
  useEffect(() => {
    seen = live;
  });
  return null;
}

const mount = async () => {
  await act(async () => {
    root.render(createElement(LiveDrawProvider, null, createElement(Probe)));
  });
};
const pass = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};
const shows = () =>
  [...container.querySelectorAll('[data-show]')].map((e) =>
    e.getAttribute('data-show'),
  );

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
  state.customer = { id: 'cus_1' };
  state.consent = 'accepted';
  state.pathname = '/';
  state.upcoming = [];
  state.results = new Map();
  state.reads = [];
  state.throwing = new Set();
  window.localStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
});

const endsInAMinute = () => new Date(START + MIN).toISOString();

describe('the watch', () => {
  test('reads nothing for a gate until the job can have drawn it', async () => {
    state.upcoming = [{ id: 'g1', ends_at: endsInAMinute() }];
    await mount();
    await pass(MIN);
    expect(state.reads).toEqual([]);
    await pass(75_000);
    expect(state.reads.length).toBeGreaterThan(0);
  });

  test('a signed-out visitor reads nothing and sees nothing', async () => {
    state.customer = null;
    state.upcoming = [{ id: 'g1', ends_at: endsInAMinute() }];
    state.results.set('g1', found('g1'));
    await mount();
    await pass(3 * MIN);
    expect(state.reads).toEqual([]);
    expect(shows()).toEqual([]);
  });

  test('stops looking once the result is in', async () => {
    state.upcoming = [{ id: 'g1', ends_at: endsInAMinute() }];
    await mount();
    await pass(MIN);
    state.results.set('g1', found('g1'));
    await pass(75_000);
    const reads = state.reads.length;
    await pass(3 * MIN);
    expect(state.reads.length).toBe(reads);
  });

  test('a hidden tab reads nothing until it comes back', async () => {
    state.upcoming = [{ id: 'g1', ends_at: endsInAMinute() }];
    state.results.set('g1', found('g1'));
    await mount();
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    document.dispatchEvent(new Event('visibilitychange'));
    await pass(3 * MIN);
    expect(state.reads).toEqual([]);
    hidden.mockReturnValue(false);
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await pass(1000);
    expect(state.reads).toEqual(['g1']);
    hidden.mockRestore();
  });

  test('a tab hidden just before its look reads nothing, armed or not', async () => {
    state.upcoming = [{ id: 'g1', ends_at: endsInAMinute() }];
    await mount();
    await pass(85_000);
    state.results.set('g1', found('g1'));
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    document.dispatchEvent(new Event('visibilitychange'));
    await pass(MIN);
    expect(state.reads).toEqual([]);
    hidden.mockRestore();
  });

  test('watches a gate the page knows about before the status does', async () => {
    await mount();
    state.results.set('g9', found('g9'));
    await act(async () => {
      seen.track([{ id: 'g9', ends_at: endsInAMinute() }]);
    });
    await pass(3 * MIN);
    expect(state.reads).toContain('g9');
  });
});

describe('the popup', () => {
  const landed = async (id = 'g1') => {
    state.upcoming = [{ id, ends_at: endsInAMinute() }];
    await mount();
    await pass(MIN);
    state.results.set(id, found(id));
    await pass(75_000);
  };

  test('pops up live for anyone signed in, small, with the gate marked drawn', async () => {
    await landed();
    expect(shows()).toEqual(['g1']);
    const el = container.querySelector('[data-show]');
    expect(el?.getAttribute('data-live')).toBe('true');
    expect(el?.getAttribute('data-expanded')).toBe('false');
    expect(seen.drawn.has('g1')).toBe(true);
    expect(seen.held.has('g1')).toBe(true);
  });

  test('a tap opens it; the X closes it and lets the result be told', async () => {
    await landed();
    await act(async () => {
      container.querySelector<HTMLElement>('[data-open]')?.click();
    });
    expect(
      container.querySelector('[data-show]')?.getAttribute('data-expanded'),
    ).toBe('true');
    const before = seen.finished;
    await act(async () => {
      container.querySelector<HTMLElement>('[data-close]')?.click();
    });
    expect(shows()).toEqual([]);
    expect(seen.held.has('g1')).toBe(false);
    expect(seen.finished).toBe(before + 1);
  });

  test('no entries, no popup', async () => {
    state.upcoming = [{ id: 'g1', ends_at: endsInAMinute() }];
    state.results.set('g1', found('g1', null));
    await mount();
    await pass(3 * MIN);
    expect(shows()).toEqual([]);
    expect(seen.drawn.has('g1')).toBe(true);
  });

  test('a draw found long after it happened is not live: Results has it', async () => {
    state.upcoming = [{ id: 'g1', ends_at: endsInAMinute() }];
    await mount();
    await pass(MIN);
    state.results.set('g1', {
      result: {
        prize_id: 'g1',
        drawn_at: new Date(Date.now() - 10 * MIN).toISOString(),
      },
      ticket_index: 2,
    });
    await pass(75_000);
    expect(shows()).toEqual([]);
    expect(seen.drawn.has('g1')).toBe(true);
  });

  test('never pops the same draw up twice in this browser', async () => {
    window.localStorage.setItem('polycards.draws-shown', '["g1"]');
    state.upcoming = [{ id: 'g1', ends_at: endsInAMinute() }];
    await mount();
    await pass(MIN);
    state.results.set('g1', found('g1'));
    await pass(75_000);
    expect(state.reads).toContain('g1');
    expect(shows()).toEqual([]);
  });

  const landedTogether = async (...ids: string[]) => {
    state.upcoming = ids.map((id) => ({ id, ends_at: endsInAMinute() }));
    await mount();
    await pass(MIN);
    for (const id of ids) state.results.set(id, found(id));
    await pass(75_000);
  };

  test('three gates in one minute all play, one after the other', async () => {
    await landedTogether('g1', 'g2', 'g3');
    const played = new Set<string | null>();
    for (let i = 0; i < 3; i++) {
      expect(shows()).toHaveLength(1);
      played.add(shows()[0] ?? null);
      await act(async () => {
        container.querySelector<HTMLElement>('[data-close]')?.click();
      });
      await pass(1000);
    }
    expect(played).toEqual(new Set(['g1', 'g2', 'g3']));
    expect(shows()).toEqual([]);
  });

  test('a phone waking long after the draw plays nothing as live', async () => {
    await landedTogether('g1', 'g2');
    expect(shows()).toHaveLength(1);
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    await pass(2 * 60 * MIN);
    hidden.mockReturnValue(false);
    const before = seen.finished;
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(shows()).toEqual([]);
    expect(seen.held.size).toBe(0);
    expect(seen.finished).toBe(before + 1);
    hidden.mockRestore();
  });

  test('a draw waiting behind a long look goes too, not one by one', async () => {
    await landedTogether('g1', 'g2');
    await pass(11 * MIN);
    await act(async () => {
      container.querySelector<HTMLElement>('[data-close]')?.click();
    });
    await pass(1000);
    expect(shows()).toEqual([]);
    expect(seen.held.size).toBe(0);
  });

  test('a show that cannot load or render leaves the page, and the next plays', async () => {
    const quiet = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    state.throwing = new Set(['g1']);
    await landedTogether('g1', 'g2');
    await pass(1000);
    expect(shows()).toEqual(['g2']);
    expect(seen.held.has('g1')).toBe(false);
    quiet.mockRestore();
  });

  test('the last show failing leaves nothing behind', async () => {
    const quiet = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    state.throwing = new Set(['g2']);
    await landedTogether('g1', 'g2');
    expect(shows()).toEqual(['g1']);
    await act(async () => {
      container.querySelector<HTMLElement>('[data-close]')?.click();
    });
    await pass(1000);
    expect(shows()).toEqual([]);
    expect(seen.held.size).toBe(0);
    quiet.mockRestore();
  });

  test('watching a draw that is not waiting opens nothing later', async () => {
    await landedTogether('g1');
    await act(async () => {
      seen.watch('nope');
    });
    expect(
      container.querySelector('[data-show]')?.getAttribute('data-expanded'),
    ).toBe('false');
  });

  test('two gates in one minute play one after the other', async () => {
    await landedTogether('g1', 'g2');
    expect(shows()).toHaveLength(1);
    const first = shows()[0];
    await act(async () => {
      container.querySelector<HTMLElement>('[data-close]')?.click();
    });
    expect(shows()).toEqual([]);
    await pass(1000);
    expect(shows()).toHaveLength(1);
    expect(shows()[0]).not.toBe(first);
  });

  test('watching one of two opens that one', async () => {
    await landedTogether('g1', 'g2');
    const other = shows()[0] === 'g1' ? 'g2' : 'g1';
    await act(async () => {
      seen.watch(other);
    });
    expect(shows()).toEqual([other]);
    expect(
      container.querySelector('[data-show]')?.getAttribute('data-expanded'),
    ).toBe('true');
  });
});

describe('gates closing in the same minute (boss 2026-11-02: lowest class first)', () => {
  const ENDS = START + MIN;
  // ENDS is 12:01:30, so the draw job's minute is 12:02:00.
  const DRAW_MINUTE = START + 90_000;
  const result = (
    id: string,
    tier: string | null,
    value: number,
    ticket: number | null = 3,
  ) => ({
    result: {
      prize_id: id,
      drawn_at: new Date(DRAW_MINUTE).toISOString(),
      tier,
      value_myr: value,
    },
    ticket_index: ticket,
  });
  const gate = (id: string, endsAt = ENDS) => ({
    id,
    ends_at: new Date(endsAt).toISOString(),
  });
  const close = async () => {
    await act(async () => {
      container.querySelector<HTMLElement>('[data-close]')?.click();
    });
    await pass(1000);
  };
  // Every first look lands 2 s past the minute, in the order listed: the highest
  // class is read first, so only the sort can put the lowest first.
  beforeEach(() => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  const untilDrawMinute = (ms: number) => pass(DRAW_MINUTE + ms - Date.now());

  test('economy, business, then first, whatever order the results come in', async () => {
    state.upcoming = [gate('first'), gate('business'), gate('economy')];
    state.results.set('first', result('first', 'first', 9000));
    state.results.set('business', result('business', 'business', 2000));
    state.results.set('economy', result('economy', 'economy', 300));
    await mount();
    await untilDrawMinute(3000);
    expect(state.reads).toEqual(['first', 'business', 'economy']);
    expect(shows()).toEqual(['economy']);
    await close();
    expect(shows()).toEqual(['business']);
    await close();
    expect(shows()).toEqual(['first']);
    await close();
    expect(shows()).toEqual([]);
  });

  test('the same class plays smallest prize first', async () => {
    state.upcoming = [gate('lucario'), gate('gengar'), gate('pikachu')];
    state.results.set('lucario', result('lucario', 'economy', 584.21));
    state.results.set('gengar', result('gengar', 'economy', 277.06));
    state.results.set('pikachu', result('pikachu', 'economy', 389.42));
    await mount();
    await untilDrawMinute(3000);
    expect(shows()).toEqual(['gengar']);
    await close();
    expect(shows()).toEqual(['pikachu']);
    await close();
    expect(shows()).toEqual(['lucario']);
  });

  test('a gate with no class plays after those with one', async () => {
    state.upcoming = [gate('none'), gate('first')];
    state.results.set('none', result('none', null, 1));
    state.results.set('first', result('first', 'first', 9000));
    await mount();
    await untilDrawMinute(3000);
    expect(shows()).toEqual(['first']);
    await close();
    expect(shows()).toEqual(['none']);
  });

  test('nothing plays until the whole minute is in, and no result is told early', async () => {
    state.upcoming = [gate('business'), gate('economy')];
    state.results.set('business', result('business', 'business', 2000));
    await mount();
    await untilDrawMinute(3000);
    expect(shows()).toEqual([]);
    expect(seen.drawn.has('business')).toBe(true);
    expect(seen.held.has('business')).toBe(true);
    state.results.set('economy', result('economy', 'economy', 300));
    await pass(13_000);
    expect(shows()).toEqual(['economy']);
    expect(seen.held.has('business')).toBe(true);
  });

  test('a gate that never draws holds the rest back only so long, then joins in order', async () => {
    state.upcoming = [gate('first'), gate('business'), gate('economy')];
    state.results.set('first', result('first', 'first', 9000));
    state.results.set('business', result('business', 'business', 2000));
    await mount();
    await untilDrawMinute(BATCH_WAIT_MS - 1000);
    expect(shows()).toEqual([]);
    await pass(2000);
    expect(shows()).toEqual(['business']);
    expect(Date.now() - DRAW_MINUTE).toBeLessThan(LIVE_MAX_AGE_MS);
    // Late, it never cuts into the show playing, but it still goes before First.
    state.results.set('economy', result('economy', 'economy', 300));
    await pass(13_000);
    expect(shows()).toEqual(['business']);
    await close();
    expect(shows()).toEqual(['economy']);
    await close();
    expect(shows()).toEqual(['first']);
  });

  test('gates read far apart: no show starts until the last is in', async () => {
    state.upcoming = [gate('first'), gate('business'), gate('economy')];
    state.results.set('first', result('first', 'first', 9000));
    await mount();
    await untilDrawMinute(3000);
    expect(shows()).toEqual([]);
    state.results.set('business', result('business', 'business', 2000));
    await pass(13_000);
    expect(shows()).toEqual([]);
    state.results.set('economy', result('economy', 'economy', 300));
    await pass(13_000);
    expect(shows()).toEqual(['economy']);
  });

  test('a whole minute drawn late still plays lowest first', async () => {
    state.upcoming = [gate('first'), gate('economy')];
    await mount();
    await untilDrawMinute(BATCH_WAIT_MS + 1000);
    state.results.set('first', result('first', 'first', 9000));
    await pass(9000);
    expect(state.reads.filter((id) => id === 'first').length).toBeGreaterThan(
      1,
    );
    expect(seen.drawn.has('first')).toBe(true);
    expect(shows()).toEqual([]);
    state.results.set('economy', result('economy', 'economy', 300));
    await pass(9000);
    expect(shows()).toEqual(['economy']);
    await close();
    expect(shows()).toEqual(['first']);
  });

  test('a draw that retries on the next job run is still waited for', async () => {
    state.upcoming = [gate('first'), gate('economy')];
    state.results.set('first', result('first', 'first', 9000));
    await mount();
    await untilDrawMinute(60_000);
    expect(shows()).toEqual([]);
    state.results.set('economy', {
      ...result('economy', 'economy', 300),
      result: {
        ...result('economy', 'economy', 300).result,
        drawn_at: new Date(DRAW_MINUTE + 60_000).toISOString(),
      },
    });
    await pass(12_000);
    expect(shows()).toEqual(['economy']);
  });

  test('a wait running out while hidden starts nothing anyone sees', async () => {
    state.upcoming = [gate('first'), gate('economy')];
    state.results.set('first', result('first', 'first', 9000));
    await mount();
    await untilDrawMinute(3000);
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    state.results.set('economy', result('economy', 'economy', 300));
    await pass(BATCH_WAIT_MS);
    hidden.mockReturnValue(false);
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    // Back, with the rest still to read: nothing flashes up first.
    expect(shows()).toEqual([]);
    await pass(1000);
    expect(shows()).toEqual(['economy']);
    await close();
    expect(shows()).toEqual(['first']);
    hidden.mockRestore();
  });

  test('a show someone was watching keeps its place after the tab was hidden', async () => {
    state.upcoming = [gate('first'), gate('economy')];
    state.results.set('first', result('first', 'first', 9000));
    await mount();
    await untilDrawMinute(3000);
    await untilDrawMinute(BATCH_WAIT_MS + 1000);
    expect(shows()).toEqual(['first']);
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    state.results.set('economy', result('economy', 'economy', 300));
    await pass(5000);
    hidden.mockReturnValue(false);
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await pass(13_000);
    expect(seen.drawn.has('economy')).toBe(true);
    expect(shows()).toEqual(['first']);
    await close();
    expect(shows()).toEqual(['economy']);
    hidden.mockRestore();
  });

  test('a batch waiting is not dropped as held back too long', async () => {
    state.upcoming = [gate('first'), gate('economy')];
    await mount();
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    state.results.set('first', result('first', 'first', 9000));
    await untilDrawMinute(118_000);
    hidden.mockReturnValue(false);
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await pass(1000);
    expect(seen.held.has('first')).toBe(true);
    await pass(3000);
    expect(seen.held.has('first')).toBe(true);
    await pass(12_000);
    expect(shows()).toEqual(['first']);
    hidden.mockRestore();
  });

  test('watching a show leaves another minute waiting', async () => {
    const next = ENDS + MIN;
    state.upcoming = [gate('now'), gate('x', next), gate('y', next)];
    state.results.set('now', result('now', 'first', 9000));
    await mount();
    await untilDrawMinute(3000);
    expect(shows()).toEqual(['now']);
    state.results.set('x', result('x', 'first', 9000));
    await pass(MIN);
    expect(seen.drawn.has('x')).toBe(true);
    await act(async () => {
      seen.watch('now');
    });
    expect(shows()).toEqual(['now']);
    await close();
    expect(shows()).toEqual([]);
    expect(seen.held.has('x')).toBe(true);
  });

  test('a show opened by name stays up while two more of its minute come in', async () => {
    state.upcoming = [gate('first'), gate('business'), gate('economy')];
    state.results.set('first', result('first', 'first', 9000));
    await mount();
    await untilDrawMinute(3000);
    await act(async () => {
      seen.watch('first');
    });
    state.results.set('business', result('business', 'business', 2000));
    await pass(13_000);
    expect(shows()).toEqual(['first']);
    state.results.set('economy', result('economy', 'economy', 300));
    await pass(13_000);
    expect(shows()).toEqual(['first']);
    await close();
    expect(shows()).toEqual(['economy']);
    await close();
    expect(shows()).toEqual(['business']);
  });

  test('watching a draw not in the queue does not end a wait', async () => {
    state.upcoming = [gate('first'), gate('economy')];
    state.results.set('first', result('first', 'first', 9000));
    await mount();
    await untilDrawMinute(3000);
    await act(async () => {
      seen.watch('nope');
    });
    expect(shows()).toEqual([]);
  });

  test('two minutes wait apart: the next never ends this one', async () => {
    const next = ENDS + MIN;
    state.upcoming = [
      gate('first'),
      gate('economy'),
      gate('x', next),
      gate('y', next),
    ];
    state.results.set('first', result('first', 'first', 9000));
    state.results.set('x', result('x', 'first', 9000));
    await mount();
    await untilDrawMinute(63_000);
    expect(seen.drawn.has('x')).toBe(true);
    expect(shows()).toEqual([]);
  });

  test('a show sent off the screen by a pack rip gives way when it comes back', async () => {
    state.upcoming = [gate('first'), gate('economy')];
    state.results.set('first', result('first', 'first', 9000));
    await mount();
    await untilDrawMinute(3000);
    await untilDrawMinute(BATCH_WAIT_MS + 1000);
    expect(shows()).toEqual(['first']);
    state.pathname = '/slots/lucky-pack/spin';
    await mount();
    expect(shows()).toEqual([]);
    state.results.set('economy', result('economy', 'economy', 300));
    await pass(13_000);
    state.pathname = '/';
    await mount();
    expect(shows()).toEqual(['economy']);
  });

  test('a gate with no entries counts as in, and plays nothing', async () => {
    state.upcoming = [gate('first'), gate('empty')];
    state.results.set('empty', result('empty', 'economy', 300, null));
    state.results.set('first', result('first', 'first', 9000));
    await mount();
    await untilDrawMinute(3000);
    expect(shows()).toEqual(['first']);
    await close();
    expect(shows()).toEqual([]);
  });

  test('a draw already shown in this browser counts as in, and plays nothing', async () => {
    window.localStorage.setItem('polycards.draws-shown', '["economy"]');
    state.upcoming = [gate('first'), gate('economy')];
    state.results.set('economy', result('economy', 'economy', 300));
    state.results.set('first', result('first', 'first', 9000));
    await mount();
    await untilDrawMinute(3000);
    expect(shows()).toEqual(['first']);
    await close();
    expect(shows()).toEqual([]);
  });

  test('a gate in a later minute waits for no one, and plays after', async () => {
    const later = ENDS + MIN;
    state.upcoming = [gate('first'), gate('economy', later)];
    state.results.set('first', result('first', 'first', 9000));
    await mount();
    await untilDrawMinute(3000);
    expect(shows()).toEqual(['first']);
    state.results.set('economy', {
      ...result('economy', 'economy', 300),
      result: {
        ...result('economy', 'economy', 300).result,
        drawn_at: new Date(DRAW_MINUTE + MIN).toISOString(),
      },
    });
    await pass(MIN + 15_000);
    expect(shows()).toEqual(['first']);
    await close();
    expect(shows()).toEqual(['economy']);
  });

  test('watching a waiting draw opens it at once, and the rest arriving leaves it up', async () => {
    state.upcoming = [gate('first'), gate('economy')];
    state.results.set('first', result('first', 'first', 9000));
    await mount();
    await untilDrawMinute(3000);
    expect(shows()).toEqual([]);
    await act(async () => {
      seen.watch('first');
    });
    expect(shows()).toEqual(['first']);
    state.results.set('economy', result('economy', 'economy', 300));
    await pass(13_000);
    expect(shows()).toEqual(['first']);
    expect(
      container.querySelector('[data-show]')?.getAttribute('data-expanded'),
    ).toBe('true');
    await close();
    expect(shows()).toEqual(['economy']);
  });

  test('a tab back after the wait still plays lowest first', async () => {
    state.upcoming = [gate('first'), gate('economy')];
    state.results.set('first', result('first', 'first', 9000));
    state.results.set('economy', result('economy', 'economy', 300));
    await mount();
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    document.dispatchEvent(new Event('visibilitychange'));
    await untilDrawMinute(BATCH_WAIT_MS + 5000);
    expect(state.reads).toEqual([]);
    hidden.mockReturnValue(false);
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await pass(1000);
    expect(shows()).toEqual(['economy']);
    await close();
    expect(shows()).toEqual(['first']);
    hidden.mockRestore();
  });

  test('a gate alone in its minute plays as soon as it is read', async () => {
    state.upcoming = [gate('first')];
    state.results.set('first', result('first', 'first', 9000));
    await mount();
    await untilDrawMinute(3000);
    expect(shows()).toEqual(['first']);
  });
});

describe('staying out of the way', () => {
  test('not during a pack rip', async () => {
    state.pathname = '/slots/lucky-pack/spin';
    state.upcoming = [{ id: 'g1', ends_at: endsInAMinute() }];
    await mount();
    await pass(MIN);
    state.results.set('g1', found('g1'));
    await pass(75_000);
    expect(seen.held.has('g1')).toBe(true);
    expect(shows()).toEqual([]);
  });

  test('not before the cookie answer', async () => {
    state.consent = null;
    state.upcoming = [{ id: 'g1', ends_at: endsInAMinute() }];
    await mount();
    await pass(MIN);
    state.results.set('g1', found('g1'));
    await pass(75_000);
    expect(shows()).toEqual([]);
  });

  test('held too long, it is dropped rather than shown as live', async () => {
    state.pathname = '/slots/lucky-pack/spin';
    state.upcoming = [{ id: 'g1', ends_at: endsInAMinute() }];
    await mount();
    await pass(MIN);
    state.results.set('g1', found('g1'));
    await pass(75_000);
    expect(seen.held.has('g1')).toBe(true);
    // The clock runs from the draw, not from whenever this tab read it: 2 minutes
    // from the draw is 45 s from here.
    await pass(46_000);
    expect(seen.held.has('g1')).toBe(false);
  });

  test('a full view dropped mid-hold does not open the next draw by itself', async () => {
    state.upcoming = [{ id: 'g1', ends_at: endsInAMinute() }];
    await mount();
    await pass(MIN);
    state.results.set('g1', found('g1'));
    await pass(75_000);
    await act(async () => {
      container.querySelector<HTMLElement>('[data-open]')?.click();
    });
    state.pathname = '/slots/lucky-pack/spin';
    await mount();
    await pass(3 * MIN);
    expect(seen.held.has('g1')).toBe(false);
    state.pathname = '/';
    await mount();
    state.results.set('g2', found('g2'));
    await act(async () => {
      seen.track([
        { id: 'g2', ends_at: new Date(Date.now() - 1000).toISOString() },
      ]);
    });
    await pass(MIN);
    expect(shows()).toEqual(['g2']);
    expect(
      container.querySelector('[data-show]')?.getAttribute('data-expanded'),
    ).toBe('false');
  });

  test('with no provider above it, a page gets an inert watcher', () => {
    let inert: ReturnType<typeof useLiveDraw> | null = null;
    function Lone() {
      const live = useLiveDraw();
      useEffect(() => {
        inert = live;
      });
      return null;
    }
    act(() => {
      root.render(createElement(Lone));
    });
    expect(inert).not.toBeNull();
    expect((inert as unknown as ReturnType<typeof useLiveDraw>).held.size).toBe(
      0,
    );
  });
});

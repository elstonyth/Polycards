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
    }) =>
      h(
        'div',
        {
          'data-show': p.detail.result.prize_id,
          'data-live': String(p.live),
          'data-expanded': String(p.expanded),
        },
        h('button', { 'data-close': true, onClick: p.onClose }),
        h('button', { 'data-open': true, onClick: p.onExpand }),
      ),
  };
});

const { LiveDrawProvider, useLiveDraw } = await import('../LiveDrawProvider');

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
    await pass(45_000);
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
    state.results.set('g1', found('g1'));
    await mount();
    await pass(2 * MIN);
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
    await pass(2 * MIN);
    expect(state.reads).toEqual([]);
    hidden.mockReturnValue(false);
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await pass(1000);
    expect(state.reads).toEqual(['g1']);
    hidden.mockRestore();
  });

  test('watches a gate the page knows about before the status does', async () => {
    await mount();
    state.results.set('g9', found('g9'));
    await act(async () => {
      seen.track([{ id: 'g9', ends_at: endsInAMinute() }]);
    });
    await pass(2 * MIN);
    expect(state.reads).toContain('g9');
  });
});

describe('the popup', () => {
  const landed = async (id = 'g1') => {
    state.upcoming = [{ id, ends_at: endsInAMinute() }];
    await mount();
    await pass(MIN);
    state.results.set(id, found(id));
    await pass(45_000);
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
    await pass(2 * MIN);
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
    await pass(45_000);
    expect(shows()).toEqual([]);
    expect(seen.drawn.has('g1')).toBe(true);
  });

  test('never pops the same draw up twice in this browser', async () => {
    window.localStorage.setItem('polycards.draws-shown', '["g1"]');
    state.upcoming = [{ id: 'g1', ends_at: endsInAMinute() }];
    state.results.set('g1', found('g1'));
    await mount();
    await pass(2 * MIN);
    expect(shows()).toEqual([]);
  });

  test('two gates in one minute play one after the other', async () => {
    state.upcoming = [
      { id: 'g1', ends_at: endsInAMinute() },
      { id: 'g2', ends_at: endsInAMinute() },
    ];
    state.results.set('g1', found('g1'));
    state.results.set('g2', found('g2'));
    await mount();
    await pass(2 * MIN);
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
    state.upcoming = [
      { id: 'g1', ends_at: endsInAMinute() },
      { id: 'g2', ends_at: endsInAMinute() },
    ];
    state.results.set('g1', found('g1'));
    state.results.set('g2', found('g2'));
    await mount();
    await pass(2 * MIN);
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

describe('staying out of the way', () => {
  test('not during a pack rip', async () => {
    state.pathname = '/slots/lucky-pack/spin';
    state.upcoming = [{ id: 'g1', ends_at: endsInAMinute() }];
    await mount();
    await pass(MIN);
    state.results.set('g1', found('g1'));
    await pass(45_000);
    expect(seen.held.has('g1')).toBe(true);
    expect(shows()).toEqual([]);
  });

  test('not before the cookie answer', async () => {
    state.consent = null;
    state.upcoming = [{ id: 'g1', ends_at: endsInAMinute() }];
    await mount();
    await pass(MIN);
    state.results.set('g1', found('g1'));
    await pass(45_000);
    expect(shows()).toEqual([]);
  });

  test('held too long, it is dropped rather than shown as live', async () => {
    state.pathname = '/slots/lucky-pack/spin';
    state.upcoming = [{ id: 'g1', ends_at: endsInAMinute() }];
    await mount();
    await pass(MIN);
    state.results.set('g1', found('g1'));
    await pass(45_000);
    expect(seen.held.has('g1')).toBe(true);
    await pass(3 * MIN);
    expect(seen.held.has('g1')).toBe(false);
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

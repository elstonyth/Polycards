// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// Plan 134: the chart is the one same-origin poller that used to cast its
// response instead of parsing it. A rolling deploy answering 200 with the
// older view shape (no `hits`) threw inside render and took the whole
// pull-history panel down through the error boundary — past this component's
// own unavailable branch. These pin the parse.

// next/image (via FramedAvatar) needs the Next runtime; the avatar is not
// what these cases assert.
vi.mock('@/components/FramedAvatar', () => ({
  FramedAvatar: () => null,
}));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const { PullGapsChart } = await import('../PullGapsChart');

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const hit = (id: string, gap: number) => ({
  id,
  gap,
  rolledAt: new Date().toISOString(),
  who: 'Ash',
  avatar: null,
  frame: null,
});

const BODY = {
  rarity: 'Immortal',
  pct: 1.1,
  expected: 91,
  avg: 88,
  last20: 74,
  current: 12,
  hits: [hit('pull_1', 40), hit('pull_2', 133)],
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  fetchMock.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function mount() {
  await act(async () => {
    root.render(createElement(PullGapsChart, { refreshKey: 'k' }));
  });
}

const unavailable = () =>
  container.textContent?.includes('Stats unavailable right now');

describe('PullGapsChart', () => {
  test('a 200 carrying an incompatible view shape falls back, never throws', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });

    await mount();

    expect(unavailable()).toBe(true);
    // No bars rendered from the unparseable body.
    expect(container.querySelectorAll('ol li')).toHaveLength(0);
  });

  test('a valid body renders the drought bar plus one bar per hit', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => BODY });

    await mount();

    expect(unavailable()).toBe(false);
    // The drought bar (current) leads, then the hits, newest first.
    const rows = container.querySelectorAll('ol li');
    expect(rows).toHaveLength(1 + BODY.hits.length);
    expect(rows[0]?.getAttribute('aria-label')).toContain(
      '12 pulls since the last Immortal',
    );
    expect(rows[1]?.getAttribute('aria-label')).toContain('40 pulls since');
  });

  test('a 503 renders the unavailable state', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ error: 'unavailable' }),
    });

    await mount();

    expect(unavailable()).toBe(true);
  });
});

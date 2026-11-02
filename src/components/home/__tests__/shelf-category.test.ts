// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CATEGORIES, packTabs, type Pack } from '@/lib/packs-data';

// The home shelf's franchise switch drives the pull history below it: Poly reads
// its capsules' feed, every other tab the global one. The feed itself is covered
// in use-recent-pulls.test.ts; this pins the wire between the two boards.

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) =>
    createElement('a', { href }, children),
}));
vi.mock('next/image', () => ({
  default: (props: { alt: string }) => createElement('img', { alt: props.alt }),
}));
vi.mock('@/components/PullHistory', () => ({
  PullHistory: ({ category }: { category?: string }) =>
    createElement('output', null, category ?? 'global'),
}));

const { ShelfCategoryProvider } = await import('../ShelfCategory');
const ShelfTabs = (await import('../ShelfTabs')).default;
const RecentPullsSection = (await import('@/components/RecentPullsSection'))
  .default;

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const tabsWith = (...ids: string[]) =>
  packTabs(
    CATEGORIES.map((c) => ({
      ...c,
      packs: ids.includes(c.id) ? [{ id: `${c.id}-pack` } as Pack] : [],
    })),
  );

const home = (ids: string[]) => {
  const categories = tabsWith(...ids);
  return createElement(ShelfCategoryProvider, {
    categories,
    children: [
      createElement(ShelfTabs, {
        key: 'shelf',
        categories,
        panels: { pokemon: 'POKE LADDER', poly: 'POLY LADDER' },
      }),
      createElement(RecentPullsSection, {
        key: 'feed',
        initial: { pulls: [], drought: {} },
      }),
    ],
  });
};

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

const feed = () => host.querySelector('output')?.textContent;
const tab = (name: string) =>
  [...host.querySelectorAll('button')].find((b) =>
    b.textContent?.startsWith(name),
  )!;

test('the feed follows the tab: global, then Poly, then global again', () => {
  act(() => root.render(home(['pokemon', 'poly'])));
  expect(feed()).toBe('global');
  expect(host.textContent).toContain('POKE LADDER');

  act(() => tab('Poly').click());
  expect(feed()).toBe('poly');
  expect(host.textContent).toContain('POLY LADDER');

  act(() => tab('Pokémon').click());
  expect(feed()).toBe('global');
});

test('a refresh that drops Poly returns the shelf and the feed to the first tab', () => {
  act(() => root.render(home(['pokemon', 'poly'])));
  act(() => tab('Poly').click());

  act(() => root.render(home(['pokemon'])));
  expect(feed()).toBe('global');
  expect(host.textContent).toContain('POKE LADDER');
});

test('a board outside the provider throws instead of rendering blank', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(() =>
    act(() =>
      root.render(
        createElement(RecentPullsSection, {
          initial: { pulls: [], drought: {} },
        }),
      ),
    ),
  ).toThrow('ShelfCategoryProvider');
});

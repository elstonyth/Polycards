// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { packTabs, type PackCategory } from '@/lib/packs-data';

// The franchise tab on /slots and the home shelf. /slots keeps it in the URL
// (?category=), so Back to a cached page and a shared link show the same tab;
// the home shelf's "All packs" link carries its pick to /slots.

let query = new URLSearchParams();
vi.mock('next/navigation', () => ({ useSearchParams: () => query }));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) =>
    createElement('a', { href }, children),
}));
vi.mock('next/image', () => ({
  default: (props: { alt: string }) => createElement('img', { alt: props.alt }),
}));
vi.mock('@/components/Reveal', () => ({
  default: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@/components/FreePackBadge', () => ({ default: () => null }));

const CatalogClient = (await import('../CatalogClient')).default;
const ShelfTabs = (await import('@/components/home/ShelfTabs')).default;

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const cat = (id: string, tab: string, names: string[]): PackCategory => ({
  id,
  tab,
  heading: tab,
  icon: `/${id}.webp`,
  packs: names.map((name) => ({
    id: name.toLowerCase(),
    name,
    priceMyr: 10,
    image: '/p.webp',
    group: 'RAW' as const,
  })),
});
const categories = [
  cat('pokemon', 'Pokémon', ['Bronze Pack']),
  cat('one-piece', 'One Piece', ['Yonko Pack']),
];

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

const render = (el: ReturnType<typeof createElement>) =>
  act(() => root.render(el));
const shown = () =>
  [...host.querySelectorAll('section p')].map((p) => p.textContent);
const tab = (name: string) =>
  [...host.querySelectorAll('[aria-label="Pack categories"] button')].find(
    (b) => b.textContent?.includes(name),
  ) as HTMLButtonElement;

test('/slots shows the franchise the URL names, else the first', () => {
  query = new URLSearchParams('category=one-piece');
  render(createElement(CatalogClient, { categories }));
  expect(shown()).toContain('Yonko Pack');
  expect(shown()).not.toContain('Bronze Pack');
  expect(tab('One Piece').getAttribute('aria-pressed')).toBe('true');

  query = new URLSearchParams('category=bogus');
  render(createElement(CatalogClient, { categories: [...categories] }));
  expect(shown()).toContain('Bronze Pack');
});

test('/slots: a tab click writes ?category= and keeps the other params', () => {
  query = new URLSearchParams();
  window.history.replaceState(null, '', '/slots?utm_source=fb');
  const replace = vi.spyOn(window.history, 'replaceState');
  render(createElement(CatalogClient, { categories }));
  act(() => tab('One Piece').click());
  expect(replace).toHaveBeenLastCalledWith(
    null,
    '',
    '?utm_source=fb&category=one-piece',
  );
});

test('/slots hides the switch with a single franchise', () => {
  query = new URLSearchParams();
  render(createElement(CatalogClient, { categories: [categories[0]!] }));
  expect(host.querySelector('[aria-label="Pack categories"]')).toBeNull();
  expect(shown()).toContain('Bronze Pack');
});

test('home shelf: the "All packs" link follows the picked franchise', () => {
  render(
    createElement(ShelfTabs, {
      categories: packTabs(categories),
      panels: { pokemon: 'POKE', 'one-piece': 'OP' },
    }),
  );
  const link = () =>
    [...host.querySelectorAll('a')].find((a) => a.textContent === 'All packs');
  expect(link()?.getAttribute('href')).toBe('/slots?category=pokemon');
  expect(host.textContent).toContain('POKE');
  act(() => tab('One Piece').click());
  expect(link()?.getAttribute('href')).toBe('/slots?category=one-piece');
  expect(host.textContent).toContain('OP');
  expect(host.textContent).not.toContain('POKE');
});

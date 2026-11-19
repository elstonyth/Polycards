// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, createElement, type AnchorHTMLAttributes } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Pack, PackCategory } from '@/lib/packs-data';

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(window.location.search),
}));
vi.mock('next/link', () => ({
  default: ({
    children,
    scroll: _scroll,
    prefetch: _prefetch,
    ...props
  }: AnchorHTMLAttributes<HTMLAnchorElement> & {
    scroll?: boolean;
    prefetch?: boolean | null;
  }) => createElement('a', props, children),
}));
vi.mock('next/image', () => ({
  default: ({ src, alt }: { src: string; alt: string }) =>
    createElement('img', { src, alt }),
}));
vi.mock('@/components/Reveal', () => ({
  default: ({
    children,
    className,
  }: {
    children: React.ReactNode;
    className?: string;
  }) => createElement('div', { className }, children),
}));
vi.mock('@/components/FreePackBadge', () => ({ default: () => null }));

const { default: CatalogClient } = await import('../CatalogClient');

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const pack = (
  id: string,
  priceMyr: number,
  over: Partial<Pack> = {},
): Pack => ({
  id,
  name: id,
  priceMyr,
  image: `/${id}.png`,
  ...over,
});
const graded = { group: 'GRADED', psa10: true } as const;
const raw = { group: 'RAW' } as const;

// One Piece as it will launch, in the admin's rank order (not price order).
const onePiece: PackCategory = {
  id: 'one-piece',
  tab: 'One Piece',
  heading: 'One Piece Packs',
  icon: '/onepiece.webp',
  packs: [
    pack('op-jp-b', 28, { packType: 'original', language: 'jp', ...raw }),
    pack('op-en', 30, { packType: 'original', language: 'en', ...raw }),
    pack('op-silver', 600, { packType: 'classic', inStock: false, ...graded }),
    pack('op-jp-a', 26, { packType: 'original', language: 'jp', ...raw }),
    pack('op-bronze', 300, { packType: 'classic', ...graded }),
    pack('op-special', 5000, { packType: 'special', ...graded }),
  ],
};

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  window.history.replaceState(null, '', '/slots');
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const render = (categories: PackCategory[]) =>
  act(() => root.render(createElement(CatalogClient, { categories })));
const sections = () => [...host.querySelectorAll('section')];
/** The packs a section links to, once each (cards and phone rows both link). */
const linked = (section: Element) => [
  ...new Set(
    [...section.querySelectorAll('a[href^="/slots/"]')].map(
      (a) => a.getAttribute('href')!.split('/')[2]!.split('?')[0],
    ),
  ),
];
/** The header block: the eyebrow and the page name share a parent. */
const intro = () => host.querySelector('h1')?.parentElement?.textContent ?? '';
const chips = () => [
  ...host.querySelectorAll<HTMLButtonElement>(
    '[aria-label$="pack language"] button',
  ),
];

test('the page is named, and says which franchise and how many packs', () => {
  render([onePiece]);
  expect(host.querySelector('h1')?.textContent).toBe('Pick a pack');
  expect(intro()).toContain('One Piece');
  expect(intro()).toContain('6 packs');
});

test('shelves run Classic, Original, Special, each naming its type', () => {
  render([onePiece]);
  // The Original shelf opens on its English packs, so its label says so: a
  // phone has no other place that states a shelf's language.
  expect(sections().map((s) => s.querySelector('span')?.textContent)).toEqual([
    'Classic',
    'Original·English',
    'Special',
  ]);
  act(() => chips()[1]!.click());
  expect(sections()[1]!.querySelector('span')?.textContent).toBe(
    'Original·Japanese',
  );
});

test('each shelf keeps its own composition heading and note', () => {
  render([onePiece]);
  expect(sections().map((s) => s.querySelector('h2')?.textContent)).toEqual([
    'Graded(Guaranteed PSA 10)',
    'Raw Cards(Ungraded)',
    'Graded(Guaranteed PSA 10)',
  ]);
});

test('a shelf lists its packs cheapest first, whatever the rank order', () => {
  render([onePiece]);
  // Silver is sold out, so it has no link: Bronze is the Classic shelf's only one.
  expect(linked(sections()[0]!)).toEqual(['op-bronze']);
  const text = sections()[0]!.textContent ?? '';
  expect(text.indexOf('op-bronze')).toBeLessThan(text.indexOf('op-silver'));
});

test('a sold-out pack says so and links nowhere', () => {
  render([onePiece]);
  expect(host.querySelector('a[href^="/slots/op-silver"]')).toBeNull();
  expect(sections()[0]!.textContent).toContain('Sold out');
});

test('a shelf with two languages shows one at a time, English first', () => {
  render([onePiece]);
  expect(chips().map((c) => c.textContent)).toEqual(['English', 'Japanese']);
  expect(linked(sections()[1]!)).toEqual(['op-en']);
  act(() => chips()[1]!.click());
  expect(linked(sections()[1]!)).toEqual(['op-jp-a', 'op-jp-b']);
});

test('the Open link carries the count picked on its card', () => {
  render([onePiece]);
  const card = host
    .querySelector('a[href="/slots/op-bronze?count=1"]')!
    .closest('.group')!;
  const plus = card.querySelector<HTMLButtonElement>(
    '[aria-label="Increase quantity"]',
  )!;
  act(() => plus.click());
  act(() => plus.click());
  expect(
    card.querySelector('a[href="/slots/op-bronze?count=3"]'),
  ).not.toBeNull();
  expect(plus.disabled).toBe(true);
});

test('an untagged franchise is one shelf with no type label', () => {
  const poly: PackCategory = {
    id: 'poly',
    tab: 'Poly',
    heading: 'Poly Packs',
    icon: '/poly.webp',
    packs: [
      pack('gold-capsule', 40, { prizeType: 'tickets' }),
      pack('lucky-pack', 10, { prizeType: 'tickets' }),
    ],
  };
  render([poly]);
  expect(host.querySelector('h1')?.textContent).toBe('Pick a capsule');
  expect(sections()).toHaveLength(1);
  expect(sections()[0]!.querySelector('h2')?.textContent).toBe('More Capsules');
  expect(linked(sections()[0]!)).toEqual(['lucky-pack', 'gold-capsule']);
  // Capsules pay tickets: no buyback sentence, no buyback line.
  expect(host.textContent).not.toContain('buyback');
});

test('no packs at all: the empty state, and no shelves', () => {
  render([{ ...onePiece, packs: [] }]);
  expect(sections()).toHaveLength(0);
  expect(host.textContent).toContain('No packs available right now');
});

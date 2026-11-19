// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, type AnchorHTMLAttributes } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Pack, PackTab, ResolvedPack } from '@/lib/packs-data';

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

const { PackPicker } = await import('../PackPicker');

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

// One Piece as it will launch: a tier ladder, sets in two languages, a special.
const SIBLINGS: Pack[] = [
  pack('op-jp-b', 28, { packType: 'original', language: 'jp', ...raw }),
  pack('op-en', 30, { packType: 'original', language: 'en', ...raw }),
  pack('op-silver', 600, { packType: 'classic', inStock: false, ...graded }),
  pack('op-jp-a', 26, { packType: 'original', language: 'jp', ...raw }),
  pack('op-bronze', 300, { packType: 'classic', ...graded }),
  pack('op-special', 5000, { packType: 'special', ...graded }),
];
const on = (id: string): ResolvedPack => ({
  ...SIBLINGS.find((p) => p.id === id)!,
  categoryId: 'one-piece',
  categoryName: 'One Piece',
  icon: '/onepiece.webp',
});

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(
  active: ResolvedPack,
  siblings = SIBLINGS,
  categoryTabs: PackTab[] = [],
  onCategory = vi.fn(),
) {
  await act(async () => {
    root.render(
      createElement(PackPicker, {
        pack: active,
        siblings,
        categoryTabs,
        qty: 2,
        onCategory,
      }),
    );
  });
}
const tiles = () =>
  [...container.querySelectorAll('[data-testid="pack-rail"] a')].map((a) =>
    a.getAttribute('href'),
  );
const chips = (group: string) => [
  ...container.querySelectorAll<HTMLButtonElement>(
    `[aria-label="${group}"] button`,
  ),
];
const pressed = (group: string) =>
  chips(group).find((b) => b.getAttribute('aria-pressed') === 'true')
    ?.textContent;

describe('PackPicker', () => {
  it('opens on the shelf of the pack on the page, cheapest first', async () => {
    await render(on('op-silver'));
    expect(pressed('Pack type')).toBe('Classic2');
    expect(tiles()).toEqual([
      '/slots/op-bronze?count=2',
      '/slots/op-silver?count=2',
    ]);
    expect(
      container.querySelector('[aria-current="page"]')?.getAttribute('href'),
    ).toBe('/slots/op-silver?count=2');
  });

  it('counts each pack type on its chip, in Classic, Original, Special order', async () => {
    await render(on('op-bronze'));
    expect(chips('Pack type').map((b) => b.textContent)).toEqual([
      'Classic2',
      'Original3',
      'Special1',
    ]);
  });

  it('switches shelf without leaving the page', async () => {
    await render(on('op-bronze'));
    await act(async () => chips('Pack type')[2]!.click());
    expect(tiles()).toEqual(['/slots/op-special?count=2']);
    // The page's own pack is on another shelf now: nothing is marked current.
    expect(container.querySelector('[aria-current="page"]')).toBeNull();
  });

  it('offers a language switch only on a shelf that holds two', async () => {
    await render(on('op-bronze'));
    expect(chips('Language')).toHaveLength(0);
    await act(async () => chips('Pack type')[1]!.click());
    expect(chips('Language').map((b) => b.textContent)).toEqual([
      'English',
      'Japanese',
    ]);
  });

  it('opens an original pack on its own language', async () => {
    await render(on('op-jp-b'));
    expect(pressed('Language')).toBe('Japanese');
    expect(tiles()).toEqual([
      '/slots/op-jp-a?count=2',
      '/slots/op-jp-b?count=2',
    ]);
    await act(async () => chips('Language')[0]!.click());
    expect(tiles()).toEqual(['/slots/op-en?count=2']);
  });

  it('keeps Graded and Raw Cards as the headings over the packs', async () => {
    await render(on('op-bronze'));
    const heading = () =>
      container.querySelector('[data-testid="pack-selector-group"] p')
        ?.textContent;
    expect(heading()).toBe('Graded');
    await act(async () => chips('Pack type')[1]!.click());
    expect(heading()).toBe('Raw Cards');
  });

  it('says when a pack is sold out', async () => {
    await render(on('op-bronze'));
    const silver = container.querySelector('a[href^="/slots/op-silver"]');
    expect(silver?.textContent).toContain('Sold out');
  });

  it('shows no type chips when nothing is tagged (an older backend)', async () => {
    const untagged = [pack('gold', 1200, graded), pack('bronze', 300, graded)];
    await render(
      { ...untagged[0]!, categoryId: 'p', categoryName: 'P', icon: '/p.webp' },
      untagged,
    );
    expect(chips('Pack type')).toHaveLength(0);
    expect(tiles()).toEqual(['/slots/bronze?count=2', '/slots/gold?count=2']);
  });

  it('renders no selector for a pack with no siblings', async () => {
    await render(on('op-bronze'), []);
    expect(container.querySelector('[data-testid="pack-selector"]')).toBeNull();
    expect(container.textContent).toContain('One Piece');
  });
});

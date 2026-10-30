// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  CATEGORIES,
  packTabs,
  pickCategory,
  type PackCategory,
  type Pack,
} from '@/lib/packs-data';

vi.mock('next/image', () => ({
  default: (props: { alt: string }) => createElement('img', { alt: props.alt }),
}));

const PackCategoryTabs = (await import('../PackCategoryTabs')).default;

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const withPacks = (...ids: string[]): PackCategory[] =>
  CATEGORIES.map((c) => ({
    ...c,
    packs: ids.includes(c.id) ? [{ id: `${c.id}-pack` } as Pack] : [],
  }));

// Operator 2026-10-30: Pokémon, One Piece, then Poly on the far right, the last
// two "Coming soon" until a pack in them is active.
describe('packTabs', () => {
  test('keeps the operator order, Poly on the far right', () => {
    expect(packTabs(withPacks('pokemon')).map((t) => t.id)).toEqual([
      'pokemon',
      'one-piece',
      'poly',
    ]);
  });

  test('a category with no active pack is coming soon', () => {
    expect(packTabs(withPacks('pokemon')).map((t) => t.soon)).toEqual([
      false,
      true,
      true,
    ]);
  });

  test('activating a pack opens the tab, with no code change', () => {
    const tabs = packTabs(withPacks('pokemon', 'poly'));
    expect(tabs.find((t) => t.id === 'poly')?.soon).toBe(false);
    expect(tabs.find((t) => t.id === 'one-piece')?.soon).toBe(true);
  });

  test('an outage does not announce everything as coming soon', () => {
    expect(packTabs(withPacks())).toEqual([]);
  });

  test('a list never opens on an empty franchise, even by link', () => {
    expect(pickCategory(withPacks('pokemon'), 'one-piece')).toBe('pokemon');
    expect(pickCategory(withPacks('poly'))).toBe('poly');
  });
});

describe('PackCategoryTabs', () => {
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

  const render = async (onChange: (id: string) => void) => {
    await act(async () =>
      root.render(
        createElement(PackCategoryTabs, {
          categories: packTabs(withPacks('pokemon')),
          active: 'pokemon',
          onChange,
        }),
      ),
    );
    return [...container.querySelectorAll('button')];
  };

  test('says Coming soon only on the empty franchises', async () => {
    const [pokemon, onePiece, poly] = await render(vi.fn());
    expect(pokemon?.textContent).toBe('Pokémon');
    expect(onePiece?.textContent).toBe('One PieceComing soon');
    expect(poly?.textContent).toBe('PolyComing soon');
  });

  test('a coming soon tab cannot be picked', async () => {
    const onChange = vi.fn();
    const [pokemon, onePiece] = await render(onChange);
    expect(onePiece?.disabled).toBe(true);
    await act(async () => onePiece?.click());
    expect(onChange).not.toHaveBeenCalled();
    expect(pokemon?.disabled).toBe(false);
    await act(async () => pokemon?.click());
    expect(onChange).toHaveBeenCalledWith('pokemon');
  });
});

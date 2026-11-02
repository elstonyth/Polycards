// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ticketCard } from '@/lib/packs-data';

// Top Hits on a ticket pack: a prize is an amount of tickets, not a card, so the
// tile shows the amount, nothing opens a card's details, and no copy says "card".

vi.mock('next/image', () => ({
  default: ({ alt }: { alt: string }) => createElement('img', { alt }),
}));
vi.mock('@/components/cards/CardTile', () => ({
  CardTile: () => createElement('div', null, 'a card tile'),
}));
vi.mock('@/lib/use-liquid-glass', () => ({
  useLiquidGlass: vi.fn(),
  GLASS_SUBTLE: {},
}));

const { PoolByRarity } = await import('../PoolByRarity');

let container: HTMLDivElement;
let root: Root;

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const RAIL = [ticketCard(1000, 'Immortal'), ticketCard(100, 'Mythical')];
const FULL = [ticketCard(10, 'Common'), ...RAIL];

async function render(onOpen = vi.fn()) {
  await act(async () => {
    root.render(
      createElement(PoolByRarity, {
        rail: RAIL,
        full: FULL,
        tierChances: { Immortal: 0.1, Mythical: 1, Common: 98.9 },
        onOpen,
      }),
    );
  });
  return onOpen;
}

describe('PoolByRarity with ticket prizes', () => {
  test('the rail shows each amount and its tier', async () => {
    await render();
    const text = container.textContent ?? '';
    expect(text).toContain('Top Hits');
    expect(text).toContain('1,000 tickets');
    expect(text).toContain('100 tickets');
    expect(text).toContain('Immortal');
    expect(text).not.toContain('a card tile');
  });

  test('no copy calls a prize a card, or the capsule a pack', async () => {
    await render();
    const expand = container.querySelector('button');
    expect(expand?.getAttribute('aria-label')).toContain('2 top ticket prizes');
    const text = container.textContent?.toLowerCase();
    expect(text).toContain('in this capsule');
    expect(text).not.toContain('card');
    expect(text).not.toContain('pack');
  });

  test('a prize has no details to open', async () => {
    const onOpen = await render();
    // The expand button is the only control on the page.
    expect(container.querySelectorAll('button')).toHaveLength(1);
    expect(onOpen).not.toHaveBeenCalled();
  });

  test('the dialog groups the prizes by tier in the same words', async () => {
    await render();
    await act(async () => {
      container.querySelector('button')?.click();
    });
    const dialog = document.querySelector('[role="dialog"]');
    const text = dialog?.textContent ?? '';
    expect(text).toContain('2 prizes');
    expect(text).toContain('1 prize');
    expect(text).toContain('0.1% pull chance');
    expect(text.toLowerCase()).not.toContain('card');
    expect(
      dialog
        ?.querySelector('[aria-label^="Close"]')
        ?.getAttribute('aria-label'),
    ).toBe('Close prize list');
  });
});

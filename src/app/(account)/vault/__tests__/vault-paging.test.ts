// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { VaultItem } from '@/lib/actions/vault';

// The vault grid renders in windows of 30. Every search or rarity change has to
// start again at the first window. That reset moved from an effect to an
// adjust-during-render (react-hooks 7.1), so pin it.

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) =>
    createElement('a', { href }, children),
}));
vi.mock('next/image', () => ({
  default: (props: { alt: string }) => createElement('img', { alt: props.alt }),
}));
vi.mock('@/components/SlabImage', () => ({ SlabImage: () => null }));
vi.mock('@/lib/actions/vault', () => ({
  // Never settles: the mount-time refresh must not replace the fixture.
  getVault: vi.fn(() => new Promise(() => {})),
  sellBackPullsBatch: vi.fn(),
  toggleShowcase: vi.fn(),
}));
vi.mock('@/lib/actions/delivery', () => ({}));
vi.mock('@/lib/actions/pack-gifts', () => ({
  getPackGifts: vi.fn(() => new Promise(() => {})),
}));
vi.mock('@/components/account/RequestDeliveryModal', () => ({
  default: () => null,
}));
vi.mock('@/components/SellConfirmModal', () => ({ default: () => null }));
vi.mock('@/components/cards/CardDetailOverlay', () => ({
  CardDetailOverlay: () => null,
}));
vi.mock('@/components/account/VaultActionBar', () => ({
  VaultActionBar: () => null,
}));
vi.mock('@/components/app-shell/TopUpProvider', () => ({
  useTopUp: () => ({ balance: 0, applyBalance: vi.fn() }),
}));
vi.mock('@/components/app-shell/VaultDotProvider', () => ({
  useVaultDot: () => ({ latestAt: null, markSeen: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('@/lib/use-consent', () => ({ useConsent: () => null }));

const VaultClient = (await import('../VaultClient')).default;

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const item = (i: number, rarity: string): VaultItem =>
  ({
    pullId: `pull_${i}`,
    rolledAt: '2026-10-01T00:00:00.000Z',
    packId: 'pack_1',
    packTitle: 'Bronze Pack',
    challengePrize: false,
    showcased: false,
    source: 'pack',
    locked: false,
    sellable: true,
    card: {
      handle: `card-${i}`,
      name: `Card ${i}`,
      rarity,
      image: null,
      slabImage: null,
      priceMyr: 10,
    },
    buyback: { percent: 90, amount: 9, firm: true, bonus: 0 },
  }) as unknown as VaultItem;

// 40 Commons and 5 Rares: 45 cards, two rarities so the filter row shows.
const items = [
  ...Array.from({ length: 40 }, (_, i) => item(i, 'Common')),
  ...Array.from({ length: 5 }, (_, i) => item(40 + i, 'Rare')),
];

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(VaultClient, {
        initial: { ok: true, items, balance: 0 },
        addresses: [],
        initialGifts: [],
      }),
    );
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const showing = () =>
  container.textContent
    ?.match(/Showing (\d+) of (\d+)/)
    ?.slice(1)
    .join('/');

function button(name: string) {
  const b = [...container.querySelectorAll('button')].find(
    (el) => el.textContent?.trim() === name,
  );
  if (!b) throw new Error(`no ${name} button`);
  return b;
}

async function click(name: string) {
  await act(async () => button(name).click());
}

async function search(text: string) {
  const input = container.querySelector<HTMLInputElement>(
    'input[type="search"]',
  )!;
  const setValue = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )!.set!;
  await act(async () => {
    setValue.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('vault paging', () => {
  test('shows the first 30 and grows by 30', async () => {
    expect(showing()).toBe('30/45');
    await click('Show more');
    expect(showing()).toBe('45/45');
  });

  test('a new search starts again at the first window', async () => {
    await click('Show more');
    await search('Card');
    expect(showing()).toBe('30/45');
    await click('Show more');
    await search('');
    expect(showing()).toBe('30/45');
  });

  test('a rarity change starts again at the first window', async () => {
    await click('Show more');
    await click('Common');
    expect(showing()).toBe('30/40');
    await click('Show more');
    await click('All');
    expect(showing()).toBe('30/45');
  });
});

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
        tickets: null,
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

describe('weekly-challenge prizes', () => {
  test('state no rarity: no tile label, no chip, no filter match', async () => {
    const prize = (i: number, rarity: string) =>
      ({ ...item(i, rarity), challengePrize: true }) as VaultItem;
    await act(async () => {
      root.render(
        createElement(VaultClient, {
          key: 'prizes',
          initial: {
            ok: true,
            items: [
              item(0, 'Common'),
              item(1, 'Rare'),
              prize(2, 'Immortal'),
              prize(3, 'Rare'),
            ],
            balance: 0,
          },
          addresses: [],
          initialGifts: [],
          tickets: null,
        }),
      );
    });
    expect(container.textContent).not.toMatch(/Immortal/i);
    await click('Rare');
    expect(showing()).toBe('1/1');
  });
});

describe('Lucky Draw tickets row', () => {
  const mount = (tickets: number | null, spinHref: string | null = null) =>
    act(async () => {
      root.render(
        createElement(VaultClient, {
          key: `tickets-${tickets}-${spinHref}`,
          initial: { ok: true, items: [], balance: 0 },
          addresses: [],
          initialGifts: [],
          tickets,
          spinHref,
        }),
      );
    });
  const link = (text: string) =>
    [...container.querySelectorAll('a')].find(
      (a) => a.textContent?.trim() === text,
    );
  const button = (text: string) =>
    [...container.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === text,
    );

  test('holding tickets: count, hint, and Use into the intro', async () => {
    await mount(3);
    expect(container.textContent).toContain('Lucky Draw Tickets ×3');
    expect(container.textContent).toContain('Put them in the prize pool');
    expect(link('Use')?.getAttribute('href')).toBe('/lucky-draw?open=1');
  });

  test('no ticket pack on sale: Get tickets goes straight to the tasks', async () => {
    await mount(3);
    expect(link('Get tickets')?.getAttribute('href')).toBe('/task');
    expect(button('Get tickets')).toBeUndefined();
  });

  test('a ticket pack on sale: Get tickets offers tasks or a spin', async () => {
    await mount(3, '/slots?category=poly');
    expect(link('Get tickets')).toBeUndefined();
    expect(link('Spin a capsule')).toBeUndefined();

    await act(async () => {
      button('Get tickets')?.click();
    });
    expect(button('Get tickets')?.getAttribute('aria-expanded')).toBe('true');
    expect(link('Go to tasks')?.getAttribute('href')).toBe('/task');
    expect(link('Spin a capsule')?.getAttribute('href')).toBe(
      '/slots?category=poly',
    );
  });

  test('a large balance is grouped like the Lucky Draw page shows it', async () => {
    await mount(1250);
    expect(container.textContent).toContain('Lucky Draw Tickets ×1,250');
  });

  test('none yet: points at the tasks, and Use still opens the pool', async () => {
    await mount(0);
    expect(container.textContent).toContain('Lucky Draw Tickets ×0');
    expect(container.textContent).toContain('Earn tickets from tasks');
    expect(link('Get tickets')?.getAttribute('href')).toBe('/task');
    // No tickets to open: no intro.
    expect(link('Use')?.getAttribute('href')).toBe('/lucky-draw');
  });

  test('unreadable balance hides the row', async () => {
    await mount(null);
    expect(container.textContent).not.toContain('Lucky Draw');
  });
});

// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ResolvedPack } from '@/lib/packs-data';

// Vault packs on the pack page (spec 2026-10-07 §1): a pack gifted into the
// vault applies itself in the bottom bar, however the player arrived —
//   qty 1:  Vault x1                 [ Open Vault x1 ]
//   qty 2:  Vault x1 + RM 300.00     [ Open Pack ]
// Both CTAs are pinned (desktop panel + mobile dock are separate branches).

const mocks = vi.hoisted(() => ({
  getPackGifts: vi.fn(),
  push: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mocks.push }),
  useSearchParams: () => new URLSearchParams(window.location.search),
}));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) =>
    createElement('a', { href }, children),
}));
vi.mock('next/image', () => ({
  default: ({ alt }: { alt: string }) => createElement('img', { alt }),
}));
vi.mock('@/components/auth/AuthProvider', () => ({
  useAuth: () => ({ customer: { id: 'cus_1' } }),
}));
vi.mock('@/components/app-shell/TopUpProvider', () => ({
  // Broke: a gift-only open must still go through.
  useTopUp: () => ({ balance: 0, openTopUp: vi.fn() }),
}));
vi.mock('@/components/AuthButton', () => ({ openAuth: vi.fn() }));
vi.mock('@/lib/actions/pack-gifts', () => ({
  getPackGifts: mocks.getPackGifts,
}));
vi.mock('@/components/Reveal', () => ({
  default: ({ children }: { children: React.ReactNode }) =>
    createElement('div', null, children),
}));
vi.mock('@/lib/use-pack-detail-poll', () => ({
  usePackDetailPoll: (_id: string, seed: unknown) => seed,
}));
vi.mock('@/lib/use-recent-pulls', () => ({
  useLiveRecentPulls: (seed: unknown) => seed,
}));
vi.mock('@/components/AmbientVideo', () => ({
  AmbientVideo: () => createElement('div'),
}));
vi.mock('@/components/SlabImage', () => ({
  SlabImage: () => createElement('div'),
}));
vi.mock('@/components/cards/CardTile', () => ({
  CardTile: () => createElement('div'),
}));
vi.mock('@/components/cards/CardDetailOverlay', () => ({
  CardDetailOverlay: () => createElement('div'),
}));
vi.mock('@/components/PullHistory', () => ({ PullHistory: () => null }));
vi.mock('../PoolByRarity', () => ({
  PoolByRarity: () => createElement('div'),
}));
vi.mock('../OddsSheet', () => ({
  PublishedOddsList: () => createElement('div'),
  hasPublishedOddsContent: () => false,
}));

const PackDetailClient = (await import('../PackDetailClient')).default;

const BRONZE: ResolvedPack = {
  id: 'bronze',
  name: 'Bronze Pack',
  priceMyr: 300,
  image: '/images/polycards/bronze-pack.webp',
  categoryId: 'pokemon',
  categoryName: 'Pokémon',
  icon: 'pokemon',
};

const gift = (over: Record<string, unknown> = {}) => ({
  packId: 'bronze',
  count: 1,
  title: 'Bronze Pack',
  image: null,
  price: 300,
  available: true,
  ...over,
});

let container: HTMLDivElement;
let root: Root;

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  mocks.push.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  window.history.replaceState(null, '', '/');
});

async function render(qty: number): Promise<{ dock: string; panel: string }> {
  window.history.replaceState(null, '', `/slots/bronze?count=${qty}`);
  await act(async () => {
    root.render(
      createElement(PackDetailClient, {
        pack: BRONZE,
        siblings: [],
        detail: null,
        recentPulls: { pulls: [], drought: {} },
      }),
    );
  });
  const dock =
    container.querySelector('[data-testid="pack-buy-dock"]')?.textContent ?? '';
  return { dock, panel: (container.textContent ?? '').replace(dock, '') };
}

describe('PackDetailClient — vault packs', () => {
  test('qty 1 with a gift: "Vault x1" and "Open Vault x1" in both zones', async () => {
    mocks.getPackGifts.mockResolvedValue([gift()]);
    const { dock, panel } = await render(1);
    expect(dock).toContain('Vault x1');
    expect(dock).toContain('Open Vault x1');
    expect(panel).toContain('Open Vault x1');
    // The desktop CTA's price slot carries the gift, not the RM price.
    const labels = [...container.querySelectorAll('button')].map(
      (b) => b.textContent,
    );
    expect(labels).toContain('Open Vault x1Vault x1');
  });

  test('qty 2 with one gift: the paid row shows, the button stays "Open Pack"', async () => {
    mocks.getPackGifts.mockResolvedValue([gift()]);
    const { dock, panel } = await render(2);
    expect(panel).toContain('Vault x1 + RM 300.00');
    expect(panel).toContain('Open Pack');
    expect(panel).not.toContain('Open Vault');
    expect(dock).toContain('Vault x1');
    expect(dock).toContain('+ RM 300.00');
    expect(dock).toContain('Open Pack');
  });

  test("a gift for another pack, or one that can't open, changes nothing", async () => {
    mocks.getPackGifts.mockResolvedValue([
      gift({ packId: 'silver' }),
      gift({ available: false }),
    ]);
    const { dock, panel } = await render(1);
    expect(panel).toContain('Open Pack');
    expect(panel).toContain('RM 300.00');
    expect(panel).not.toContain('Vault x');
    expect(dock).not.toContain('Vault x');
  });

  test('an unreadable gift list reads as none', async () => {
    mocks.getPackGifts.mockResolvedValue(null);
    const { panel } = await render(1);
    expect(panel).toContain('Open Pack');
    expect(panel).not.toContain('Vault x');
  });

  // Balance 0: a gift-only open must not be refused as "Not enough credits".
  test('a gift-only open goes to the reel even with no balance', async () => {
    mocks.getPackGifts.mockResolvedValue([gift()]);
    await render(1);
    const open = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === 'Open Vault x1',
    );
    expect(open).toBeDefined();
    await act(async () => open!.click());
    expect(mocks.push).toHaveBeenCalledWith('/slots/bronze/spin?count=1');
    expect(container.textContent).not.toContain('Not enough credits');
  });
});

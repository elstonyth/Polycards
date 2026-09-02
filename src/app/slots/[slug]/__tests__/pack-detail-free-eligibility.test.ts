// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { FREE_WELCOME_CATEGORY, type ResolvedPack } from '@/lib/packs-data';

// The free pack is only HIDDEN from the catalog, never gated at the route — a
// shared link, browser history, or a stale badge lands an ineligible account on
// /slots/<free-slug> just fine. Before `freePackEligible`, that page rendered
// the gift offer unconditionally (it keyed purely on the pack's category), so a
// customer who had already spent their claim was promised "nothing charged" by
// a page whose backend then refuses the open at the reel.
//
// These pin the honest states instead. The guest case matters as much as the
// spent one: page.tsx maps the logged-out `signup` badge state to eligible=true
// precisely so a visitor still sees the offer that brought them here, and
// handleGoToReel prompts login on tap.

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
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
  useTopUp: () => ({ balance: 0, openTopUp: vi.fn() }),
}));
vi.mock('@/components/AuthButton', () => ({ openAuth: vi.fn() }));
// Scroll-reveal + polling are ambient behavior this branch does not touch:
// render children immediately and hold the server snapshot still.
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
vi.mock('../PoolByRarity', () => ({
  PoolByRarity: () => createElement('div'),
}));
vi.mock('../OddsSheet', () => ({
  PublishedOddsList: () => createElement('div'),
  hasPublishedOddsContent: () => false,
}));

const PackDetailClient = (await import('../PackDetailClient')).default;

const FREE_PACK: ResolvedPack = {
  id: 'welcome-pack',
  name: 'Welcome Pack',
  price: 'RM 0',
  priceValue: 0,
  image: '/images/polycards/free-pack-badge.webp',
  categoryId: FREE_WELCOME_CATEGORY,
  categoryName: 'Free pack',
  icon: 'pokemon',
};

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

async function render(freePackEligible?: boolean): Promise<string> {
  await act(async () => {
    root.render(
      createElement(PackDetailClient, {
        pack: FREE_PACK,
        siblings: [],
        detail: null,
        recentPulls: { pulls: [], drought: {} },
        freePackEligible,
      }),
    );
  });
  return container.textContent ?? '';
}

describe('PackDetailClient — free pack eligibility', () => {
  test('offers the open to an eligible claimer', async () => {
    const text = await render(true);
    expect(text).toContain('Open Free Pack');
    expect(text).toContain('nothing charged');
    expect(text).not.toContain("isn't available");
  });

  // The prop defaults to true so every paid pack (page.tsx passes nothing for
  // them) keeps rendering exactly as before.
  test('defaults to the offer when the prop is absent', async () => {
    expect(await render(undefined)).toContain('Open Free Pack');
  });

  // Wording matters here, not just suppression: ineligible covers a spent claim
  // AND a failed eligibility read, which the storefront cannot tell apart. Copy
  // asserting a past claim would be a lie to a first-time guest whose read fell
  // over, so the state must stay neutral about WHY.
  test('tells an ineligible visitor the truth instead of promising a gift', async () => {
    const text = await render(false);
    expect(text).toContain(
      "This welcome pack isn't available on this account.",
    );
    expect(text).not.toContain('Already claimed');
    expect(text).not.toContain('Open Free Pack');
    // The specific lie: a page that still promised "nothing charged" while the
    // backend would refuse the open.
    expect(text).not.toContain('nothing charged');
  });

  // Two CTAs render per page (desktop panel footer + mobile buy dock) and they
  // are separate JSX branches — an earlier fix that touched only one left the
  // other offering the gift.
  test('suppresses the CTA in BOTH the desktop panel and the mobile dock', async () => {
    await render(false);
    const dock = container.querySelector('[data-testid="pack-buy-dock"]');
    expect(dock).not.toBeNull();
    const dockText = dock?.textContent ?? '';
    expect(dockText).not.toContain('Open Free Pack');
    // Positive half: the dock must still SAY something in the slot the CTA
    // vacated, or it collapses and the bottom chrome reads as a broken layout.
    expect(dockText).toContain('Not available on this account');
    expect(dockText).not.toContain('Claimed');
    // The desktop panel is a separate JSX branch — assert it independently of
    // the dock, so suppressing one and not the other cannot pass.
    const panelText = (container.textContent ?? '').replace(dockText, '');
    expect(panelText).not.toContain('Open Free Pack');
    expect(panelText).toContain("isn't available on this account");
  });
});

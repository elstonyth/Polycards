// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PackCard, ResolvedPack } from '@/lib/packs-data';
import type { PackDetail } from '@/lib/data/packs';
import { renderHook } from '@/lib/__tests__/render-hook';

// The buy logic lifted out of PackDetailClient (use-pack-buy) and the controls
// that read it (PackBuyControls). PackDetailClient's own suites keep covering
// the page; these pin the model for the homepage flow, which drives it alone.

const m = vi.hoisted(() => ({
  customer: null as { id: string } | null,
  balance: null as number | null,
  gifts: { held: 0, pending: false, failed: false },
  push: vi.fn(),
  openAuth: vi.fn(),
  openTopUp: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: m.push }) }));
vi.mock('next/link', () => ({
  default: ({
    children,
    ...props
  }: Record<string, unknown> & { children?: ReactNode }) =>
    createElement('a', props, children),
}));
vi.mock('@/components/auth/AuthProvider', () => ({
  useAuth: () => ({ customer: m.customer }),
}));
vi.mock('@/components/app-shell/TopUpProvider', () => ({
  useTopUp: () => ({ balance: m.balance, openTopUp: m.openTopUp }),
}));
vi.mock('@/components/AuthButton', () => ({ openAuth: m.openAuth }));
vi.mock('@/lib/use-pack-gifts', () => ({
  usePackGifts: (id: string | null) =>
    id ? m.gifts : { held: 0, pending: false, failed: false },
}));

const { usePackBuy } = await import('../use-pack-buy');
const { PackBuyControls } = await import('../PackBuyControls');
const { BUYBACK_RULE } = await import('@/components/pack-3d/pack-back-details');

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const GOLD: ResolvedPack = {
  id: 'gold-pack',
  name: 'Gold Pack',
  priceMyr: 1200,
  image: '/g.webp',
  categoryId: 'pokemon',
  categoryName: 'Pokemon',
  icon: '/p.webp',
  buybackPercent: 90,
};
const CAPSULE: ResolvedPack = {
  ...GOLD,
  id: 'gold-capsule',
  name: 'Gold Capsule',
  priceMyr: 40,
  categoryId: 'poly',
  prizeType: 'tickets',
};
const card: PackCard = {
  handle: 'c',
  name: 'C',
  image: '/c.png',
  slabImage: null,
  rarity: 'Immortal',
  priceMyr: 10,
  pokemonDex: null,
  spriteImage: null,
};
const DETAIL: PackDetail = { topHits: [], pool: [card], pullOdds: null };

beforeEach(() => {
  m.customer = null;
  m.balance = null;
  m.gifts = { held: 0, pending: false, failed: false };
  m.push.mockClear();
  m.openAuth.mockClear();
  window.history.replaceState(null, '', '/slots/gold-pack');
});

type P = { pack: ResolvedPack; detail: PackDetail | null; qty?: number };
const hook = (p: P) =>
  renderHook(
    ({ pack, detail, qty }: P) =>
      usePackBuy(pack, detail, qty ? { initialQty: qty } : undefined),
    p,
  );

describe('usePackBuy', () => {
  it('a guest: log in to open, demo offered, Open asks for login', () => {
    const h = hook({ pack: GOLD, detail: DETAIL });
    expect(h.current).toMatchObject({
      signedIn: false,
      qty: 1,
      maxQty: 3,
      soldOut: false,
      showDemo: true,
      showExplainer: true,
      showQty: true,
      demoHref: '/slots/gold-pack/spin?demo=1',
      noun: 'pack',
      buybackPercent: 90,
    });
    act(() => h.current.handleGoToReel());
    expect(m.openAuth).toHaveBeenCalledWith('login');
    expect(m.push).not.toHaveBeenCalled();
    h.unmount();
  });

  it('no demo without a pool', () => {
    const h = hook({ pack: GOLD, detail: null });
    expect(h.current.showDemo).toBe(false);
    h.unmount();
  });

  it('quantity comes from the address, clamped, and setQ replaces it', () => {
    window.history.replaceState(null, '', '/slots/gold-pack?count=7&x=1');
    const h = hook({ pack: GOLD, detail: DETAIL, qty: 2 });
    expect(h.current.qty).toBe(3);
    const before = window.history.length;
    act(() => h.current.setQ(1));
    expect(window.location.search).toBe('?count=1&x=1');
    expect(h.current.qty).toBe(1);
    act(() => h.current.setQ(9));
    expect(h.current.qty).toBe(3);
    expect(window.history.length).toBe(before);
    h.unmount();
  });

  it("a quantity tap keeps the entry's own state (the flow's marker), never Next's", () => {
    window.history.replaceState(
      { __flow: 'f1', __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: {} },
      '',
      '/slots/gold-pack',
    );
    const h = hook({ pack: GOLD, detail: DETAIL });
    act(() => h.current.setQ(2));
    expect(window.history.state).toEqual({ __flow: 'f1' });
    expect(window.location.search).toBe('?count=2');
    h.unmount();
    // The pack page's own entries carry nothing of ours: written as before.
    window.history.replaceState(null, '', '/slots/gold-pack');
    const p = hook({ pack: GOLD, detail: DETAIL });
    act(() => p.current.setQ(3));
    expect(window.history.state).toBeNull();
    p.unmount();
  });

  it('no count in the address: the server prop; junk: one', () => {
    const h = hook({ pack: GOLD, detail: DETAIL, qty: 2 });
    expect(h.current.qty).toBe(2);
    h.unmount();
    window.history.replaceState(null, '', '/slots/gold-pack?count=abc');
    const j = hook({ pack: GOLD, detail: DETAIL, qty: 2 });
    expect(j.current.qty).toBe(1);
    j.unmount();
  });

  it('Back to an entry with another count re-reads it', () => {
    const h = hook({ pack: GOLD, detail: DETAIL });
    window.history.replaceState(null, '', '/slots/gold-pack?count=2');
    act(() => window.dispatchEvent(new PopStateEvent('popstate')));
    expect(h.current.qty).toBe(2);
    h.unmount();
  });

  it('short of balance: refuses with a top-up, never navigates', () => {
    m.customer = { id: 'c' };
    m.balance = 100;
    const h = hook({ pack: GOLD, detail: DETAIL });
    act(() => h.current.handleGoToReel());
    expect(h.current.openError).toBe('Not enough balance to open.');
    expect(h.current.needsTopUp).toBe(true);
    expect(m.push).not.toHaveBeenCalled();
    h.unmount();
  });

  it('enough balance: to the reel with the quantity', () => {
    m.customer = { id: 'c' };
    m.balance = 5000;
    window.history.replaceState(null, '', '/slots/gold-pack?count=3');
    const h = hook({ pack: GOLD, detail: DETAIL });
    act(() => h.current.handleGoToReel());
    expect(m.push).toHaveBeenCalledWith('/slots/gold-pack/spin?count=3');
    h.unmount();
  });

  it('onGoToReel takes the reel address instead of a navigation', () => {
    m.customer = { id: 'c' };
    m.balance = 5000;
    window.history.replaceState(null, '', '/slots/gold-pack?count=2');
    const onGoToReel = vi.fn();
    const h = renderHook(
      () => usePackBuy(GOLD, DETAIL, { onGoToReel }),
      undefined,
    );
    act(() => h.current.handleGoToReel());
    expect(onGoToReel).toHaveBeenCalledWith('/slots/gold-pack/spin?count=2');
    expect(m.push).not.toHaveBeenCalled();
    h.unmount();
  });

  it('gifts cover rows first; a gift still being read never refuses', () => {
    m.customer = { id: 'c' };
    m.balance = 0;
    m.gifts = { held: 1, pending: false, failed: false };
    window.history.replaceState(null, '', '/slots/gold-pack?count=2');
    const h = hook({ pack: GOLD, detail: DETAIL });
    expect(h.current).toMatchObject({ vaultGifts: 1, paidCost: 1200 });
    expect(h.current.vaultCost).toContain('Vault x1');
    h.unmount();
    m.gifts = { held: 0, pending: true, failed: false };
    const p = hook({ pack: GOLD, detail: DETAIL });
    act(() => p.current.handleGoToReel());
    expect(m.push).toHaveBeenCalledWith('/slots/gold-pack/spin?count=2');
    p.unmount();
  });

  it('sold out: no controls, unless a gift covers the open', () => {
    const h = hook({ pack: { ...GOLD, inStock: false }, detail: DETAIL });
    expect(h.current).toMatchObject({
      soldOut: true,
      unavailableLabel: 'Sold out',
      showDemo: false,
      showQty: false,
      maxQty: 1,
    });
    h.unmount();
    m.customer = { id: 'c' };
    m.gifts = { held: 2, pending: false, failed: false };
    const g = hook({ pack: { ...GOLD, inStock: false }, detail: DETAIL });
    expect(g.current).toMatchObject({ soldOut: false, maxQty: 2 });
    expect(g.current.openLabel).toBe('Open Vault x1');
    g.unmount();
  });

  it('a Draft card pack is preview only; a Draft capsule can open', () => {
    const d = hook({ pack: { ...GOLD, draft: true }, detail: DETAIL });
    expect(d.current).toMatchObject({
      previewOnly: true,
      soldOut: true,
      unavailableLabel: 'Preview only',
    });
    d.unmount();
    const c = hook({ pack: { ...CAPSULE, draft: true }, detail: DETAIL });
    expect(c.current).toMatchObject({
      previewOnly: false,
      soldOut: false,
      noun: 'capsule',
      Noun: 'Capsule',
      openLabel: 'Open Capsule',
      showExplainer: false,
    });
    c.unmount();
  });

  it('a new pack starts clean: no error left from the last one', () => {
    m.customer = { id: 'c' };
    m.balance = 100;
    const h = hook({ pack: GOLD, detail: DETAIL });
    act(() => h.current.handleGoToReel());
    expect(h.current.openError).not.toBeNull();
    h.rerender({ pack: { ...GOLD, id: 'silver-pack' }, detail: DETAIL });
    expect(h.current.openError).toBeNull();
    expect(h.current.needsTopUp).toBe(false);
    h.unmount();
  });
});

describe('PackBuyControls', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });
  function Harness({
    pack,
    variant,
  }: {
    pack: ResolvedPack;
    variant: 'dock' | 'panel';
  }) {
    const model = usePackBuy(pack, DETAIL);
    return createElement(PackBuyControls, { model, variant });
  }
  const show = (variant: 'dock' | 'panel', pack = GOLD) =>
    act(() => root.render(createElement(Harness, { pack, variant })));
  const text = () => (host.textContent ?? '').replace(/\s+/g, ' ');

  it('panel: terms, demo, stepper with Max, then the Open footer', () => {
    show('panel');
    // Drift guard: the 3D back prints this sentence word for word.
    const explainer = [...host.querySelectorAll('p')].find((p) =>
      p.textContent?.startsWith('The pack rate applies'),
    );
    expect(explainer?.textContent?.replace(/\s+/g, ' ')).toBe(BUYBACK_RULE);
    expect(text()).toContain('Try a free demo spin');
    expect(text()).toContain('1 Pack');
    expect(text()).toContain('Max');
    expect(text()).toContain('Log in to open');
    expect(text()).toContain('RM 1,200.00');
    act(() =>
      host
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Increase quantity"]',
        )!
        .click(),
    );
    expect(text()).toContain('2 Packs');
    expect(text()).toContain('RM 2,400.00');
    const max = [...host.querySelectorAll('button')].find(
      (b) => b.textContent === 'Max',
    );
    act(() => max!.click());
    expect(text()).toContain('3 Packs');
    expect(window.location.search).toBe('?count=3');
  });

  it('dock: total, terms line, stepper and one pill', () => {
    show('dock');
    expect(host.querySelector('[data-testid="pack-buy-dock"]')).not.toBeNull();
    expect(text()).toContain('RM 1,200.00');
    expect(text()).toContain('90% during reveal');
    expect(text()).toContain('Log in');
    show('dock', CAPSULE);
    expect(text()).toContain('Lucky Draw tickets');
  });

  it('dock: the refusal under it', () => {
    m.customer = { id: 'c' };
    m.balance = 10;
    show('dock');
    const open = [...host.querySelectorAll('button')].find(
      (b) => b.textContent === 'Open Pack',
    );
    act(() => open!.click());
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      'Not enough balance to open.',
    );
    expect(text()).toContain('short.');
  });

  it('sold out: the disabled pill in every variant', () => {
    for (const v of ['panel', 'dock'] as const) {
      show(v, { ...GOLD, inStock: false });
      const pill = [...host.querySelectorAll('button')].find(
        (b) => b.textContent === 'Sold out',
      );
      expect(pill?.disabled, v).toBe(true);
    }
  });
});

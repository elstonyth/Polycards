// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ticketCard, type PackCard, type ResolvedPack } from '@/lib/packs-data';
import { packTiersOf } from '@/lib/pack-tiers';
import type { PackDetail } from '@/lib/data/packs';
import { renderHook, flush } from '@/lib/__tests__/render-hook';

// The focused pack's chapters (plan-step2 section 1): composed from the pack
// page's parts, reporting its stops in order, leaving behind a fade, and the
// capsule and no-odds versions.

const m = vi.hoisted(() => ({ push: vi.fn(), openAuth: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: m.push }) }));
vi.mock('next/link', () => ({
  default: ({
    children,
    prefetch: _p,
    ...props
  }: Record<string, unknown> & { children?: ReactNode }) =>
    createElement('a', props, children),
}));
vi.mock('next/image', () => ({
  default: ({ alt }: { alt: string }) => createElement('img', { alt }),
}));
vi.mock('@/components/auth/AuthProvider', () => ({
  useAuth: () => ({ customer: null }),
}));
vi.mock('@/components/app-shell/TopUpProvider', () => ({
  useTopUp: () => ({ balance: null, openTopUp: vi.fn() }),
}));
vi.mock('@/components/AuthButton', () => ({ openAuth: m.openAuth }));
vi.mock('@/lib/use-pack-gifts', () => ({
  usePackGifts: () => ({ held: 0, pending: false, failed: false }),
}));
vi.mock('@/lib/use-liquid-glass', () => ({
  useLiquidGlass: vi.fn(),
  GLASS_SUBTLE: {},
}));
vi.mock('@/components/cards/PokemonBadge', () => ({
  PokemonBadge: () => null,
}));
vi.mock('@/components/Reveal', () => ({
  default: ({ children }: { children: ReactNode }) =>
    createElement('section', null, children),
}));
vi.mock('@/components/PullHistory', () => ({
  PullHistory: (p: { packSlug: string; noun: string }) =>
    createElement('div', { 'data-history': `${p.packSlug}|${p.noun}` }),
}));
vi.mock('@/components/cards/CardDetailOverlay', () => ({
  CardDetailOverlay: (p: { seed: { handle: string } | null }) =>
    p.seed ? createElement('div', { 'data-overlay': p.seed.handle }) : null,
}));

const { FlowChapters, LEAVE_FADE_MS, miniHeaderText } =
  await import('../FlowChapters');
const { walkRows } = await import('@/app/slots/[slug]/PackTierWalk');
const { useFlowData } = await import('../use-flow-data');
const { flowSeedFromHighlights } = await import('../flow-seed');
const { backFor, backKey, canTurn, shapeOf } = await import('../flow-back');
type FlowData = import('../types').FlowData;
type FlowScrollSource = import('../types').FlowScrollSource;

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const card = (
  n: number,
  rarity: PackCard['rarity'],
  priceMyr: number,
): PackCard => ({
  handle: `card-${n}`,
  name: `Card ${n}`,
  image: `/c${n}.png`,
  slabImage: null,
  rarity,
  priceMyr,
  pokemonDex: null,
  spriteImage: null,
});
const GOLD: ResolvedPack = {
  id: 'gold-pack',
  name: 'Gold Pack',
  priceMyr: 1200,
  image: '/g.webp',
  categoryId: 'pokemon',
  categoryName: 'Pokémon',
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
const DETAIL: PackDetail = {
  topHits: [],
  pool: [
    card(1, 'Immortal', 9000),
    card(2, 'Legendary', 800),
    card(3, 'Common', 5),
  ],
  pullOdds: { tiers: { Immortal: 0.2, Legendary: 2.8, Common: 97 } },
};
const TICKETS: PackDetail = {
  topHits: [],
  pool: [
    ticketCard(1200, 'Immortal'),
    ticketCard(300, 'Legendary'),
    ticketCard(16, 'Common'),
  ],
  pullOdds: { tiers: { Immortal: 0.1, Legendary: 1.4, Common: 98.5 } },
};

function dataFor(pack: ResolvedPack, detail: PackDetail): FlowData {
  const tiers = packTiersOf(pack, detail);
  const pullOdds = detail.pullOdds;
  const back = backFor(pack, pullOdds);
  return {
    pack,
    shape: shapeOf(pack),
    tiers,
    live: tiers?.pack ?? null,
    recentPulls: { pulls: [], drought: {} },
    pullOdds,
    back,
    backKey: backKey(back),
    turns: canTurn({ shape: shapeOf(pack) }, back),
  };
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  m.push.mockReset();
  window.matchMedia = ((q: string) => ({
    matches: false,
    media: q,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia;
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});
const text = () => (host.textContent ?? '').replace(/\s+/g, ' ');
const show = (
  props: Partial<Parameters<typeof FlowChapters>[0]> & { data: FlowData },
) =>
  act(() =>
    root.render(createElement(FlowChapters, { onLeave: vi.fn(), ...props })),
  );

describe('FlowChapters', () => {
  it('stop 1, the tier walk, the odds board with counts, Recent Pulls and the closing band', () => {
    show({ data: dataFor(GOLD, DETAIL) });
    expect(host.querySelector('h1')?.textContent).toBe('Gold Pack');
    expect(text()).toContain('All packs');
    expect(text()).toContain('90% instant buyback');
    expect([...host.querySelectorAll('h3')].map((h) => h.textContent)).toEqual([
      'Immortal',
      'Legendary',
    ]);
    expect(text()).toContain('Pull Odds (by rarity)');
    expect(text()).toContain('1 card');
    expect(
      host.querySelector('[data-history="gold-pack|pack"]'),
    ).not.toBeNull();
    expect(text()).toContain('Open Gold Pack · RM 1,200.00');
    expect(text()).toContain('Back to all packs');
    // The phone dock, the desktop configurator and the compact bar.
    expect(host.querySelector('[data-testid="pack-buy-dock"]')).not.toBeNull();
    expect(
      host.querySelector('[data-testid="pack-buy-compact"]'),
    ).not.toBeNull();
    expect(text()).toContain('Log in to open');
    // The flat stand-in holds the pack's place.
    expect(host.querySelector('img[src="/g.webp"]')).not.toBeNull();
  });

  it('reports its stops in order: back, one per tier, odds', () => {
    let source: FlowScrollSource | null = null;
    const unbind = vi.fn();
    show({
      data: dataFor(GOLD, DETAIL),
      bindScroll: (s) => {
        source = s;
        return unbind;
      },
    });
    expect(source!.stops()!.map((s) => s.kind)).toEqual([
      'back',
      'tier',
      'tier',
      'odds',
    ]);
    act(() => root.unmount());
    expect(unbind).toHaveBeenCalledOnce();
    root = createRoot(host);
  });

  it('no pull odds: no chances, no odds board, no odds stop', () => {
    let source: FlowScrollSource | null = null;
    show({
      data: dataFor(GOLD, { ...DETAIL, pullOdds: null }),
      bindScroll: (s) => {
        source = s;
        return () => {};
      },
    });
    expect(text()).not.toContain('Pull Odds');
    expect(text()).not.toContain('a pull');
    expect(source!.stops()!.map((s) => s.kind)).toEqual([
      'back',
      'tier',
      'tier',
    ]);
  });

  it('a capsule: capsule words, prizes, no buyback anywhere', () => {
    show({ data: dataFor(CAPSULE, TICKETS) });
    expect(text()).toContain('All capsules');
    expect(text()).toContain('Back to all capsules');
    expect(text()).toContain('Lucky Draw tickets');
    expect(text()).toContain('1,200');
    expect(text()).not.toMatch(/buyback/i);
    expect(
      host.querySelector('[data-history="gold-capsule|capsule"]'),
    ).not.toBeNull();
  });

  it('leaving fades for 250 ms, then hands over', () => {
    vi.useFakeTimers();
    const onLeave = vi.fn();
    show({ data: dataFor(GOLD, DETAIL), onLeave });
    const back = [...host.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Back to all packs'),
    )!;
    act(() => back.click());
    expect(
      host
        .querySelector('[data-testid="pack-flow"]')
        ?.getAttribute('data-leaving'),
    ).toBe('1');
    expect(onLeave).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(LEAVE_FADE_MS));
    expect(onLeave).toHaveBeenCalledOnce();
  });

  it('reduced motion: leaves at once; Escape leaves unless a dialog is open', () => {
    window.matchMedia = ((q: string) => ({
      matches: q.includes('reduce'),
      media: q,
      addEventListener() {},
      removeEventListener() {},
    })) as unknown as typeof window.matchMedia;
    const onLeave = vi.fn();
    show({ data: dataFor(GOLD, DETAIL), onLeave });
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    document.body.append(dialog);
    act(() =>
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })),
    );
    expect(onLeave).not.toHaveBeenCalled();
    dialog.remove();
    act(() =>
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })),
    );
    expect(onLeave).toHaveBeenCalledOnce();
  });

  it('Escape that closes a dialog (which removes itself first) does not leave', () => {
    window.matchMedia = ((q: string) => ({
      matches: q.includes('reduce'),
      media: q,
      addEventListener() {},
      removeEventListener() {},
    })) as unknown as typeof window.matchMedia;
    const onLeave = vi.fn();
    show({ data: dataFor(GOLD, DETAIL), onLeave });
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    document.body.append(dialog);
    // As useModalA11y does: a document listener closes the dialog on Escape.
    const close = (e: KeyboardEvent) => e.key === 'Escape' && dialog.remove();
    document.addEventListener('keydown', close);
    act(() =>
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      ),
    );
    document.removeEventListener('keydown', close);
    expect(dialog.isConnected).toBe(false);
    expect(onLeave).not.toHaveBeenCalled();
  });

  it('restores the saved chapter only once the tier view is in (Back from the reel)', () => {
    window.sessionStorage.setItem('pack-flow:chapter:f1', '640');
    const scrollTo = vi.fn();
    window.scrollTo = scrollTo as unknown as typeof window.scrollTo;
    const data = dataFor(GOLD, DETAIL);
    show({ data: { ...data, tiers: null }, entryId: 'f1' });
    expect(scrollTo).not.toHaveBeenCalled();
    show({ data, entryId: 'f1' });
    expect(scrollTo).toHaveBeenCalledWith({ top: 640, behavior: 'instant' });
    window.sessionStorage.clear();
  });

  it('Open goes through the reel seam; a card opens the overlay', () => {
    const onGoToReel = vi.fn();
    show({ data: dataFor(GOLD, DETAIL), onGoToReel });
    act(() =>
      host
        .querySelector<HTMLButtonElement>(
          'button[aria-label^="View details for Card 1"]',
        )!
        .click(),
    );
    expect(host.querySelector('[data-overlay="card-1"]')).not.toBeNull();
    // A guest's Open asks to log in; the seam is exercised in use-pack-buy's tests.
    const open = [...host.querySelectorAll('button')].find((b) =>
      b.textContent?.startsWith('Log in to open'),
    )!;
    act(() => open.click());
    expect(m.openAuth).toHaveBeenCalledWith('login');
  });

  it('the mini header follows the stop, chance only when entered', () => {
    const rows = walkRows(dataFor(GOLD, DETAIL).tiers!.tiers, false);
    expect(
      miniHeaderText('Gold Pack', { kind: 'back', tier: null }, rows),
    ).toBe('Gold Pack');
    expect(miniHeaderText('Gold Pack', { kind: 'tier', tier: 0 }, rows)).toBe(
      'Gold Pack · Immortal · 0.2%',
    );
    expect(
      miniHeaderText('Gold Pack', { kind: 'odds', tier: null }, rows),
    ).toBe('Gold Pack · Pull Odds');
    const noOdds = walkRows(
      dataFor(GOLD, { ...DETAIL, pullOdds: null }).tiers!.tiers,
      false,
    );
    expect(miniHeaderText('Gold Pack', { kind: 'tier', tier: 1 }, noOdds)).toBe(
      'Gold Pack · Legendary',
    );
  });
});

describe('useFlowData', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('homepage seed: nothing fetched until enabled; then the tiers fill in', async () => {
    await (await import('@/lib/lazy-schemas')).loadSchemas();
    const tiers = packTiersOf(GOLD, DETAIL)!;
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => JSON.parse(JSON.stringify(tiers)),
    });
    const seed = flowSeedFromHighlights(GOLD, {
      pullOdds: DETAIL.pullOdds,
    });
    const h = renderHook(
      ({ enabled }: { enabled: boolean }) => useFlowData(seed, { enabled }),
      { enabled: false },
    );
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.current.tiers).toBeNull();
    expect(h.current.turns).toBe(true);
    expect(h.current.recentPulls).toEqual({ pulls: [], drought: {} });
    h.rerender({ enabled: true });
    await flush();
    await flush();
    expect(fetchMock).toHaveBeenCalledWith('/api/pack-tiers/gold-pack', {
      cache: 'no-store',
    });
    expect(h.current.tiers?.tiers[0]?.rarity).toBe('Immortal');
    expect(h.current.back?.odds?.[0]).toEqual({
      label: 'Immortal',
      chance: '0.2%',
    });
    h.unmount();
  });

  it('a capsule never turns; a pack with no odds never turns', () => {
    const cap = renderHook(
      () =>
        useFlowData(
          flowSeedFromHighlights(CAPSULE, { pullOdds: TICKETS.pullOdds }),
          { enabled: false },
        ),
      undefined,
    );
    expect(cap.current.turns).toBe(false);
    expect(cap.current.back).toBeNull();
    cap.unmount();
    const none = renderHook(
      () =>
        useFlowData(flowSeedFromHighlights(GOLD, { pullOdds: null }), {
          enabled: false,
        }),
      undefined,
    );
    expect(none.current.turns).toBe(false);
    expect(none.current.backKey).toBe('none');
    none.unmount();
  });
});

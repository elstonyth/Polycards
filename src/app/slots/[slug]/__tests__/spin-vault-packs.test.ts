// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Pack, PackCard, ResolvedPack } from '@/lib/packs-data';

// Vault packs on the spin page (spec 2026-10-07 §1): the press sends
// gifts = min(reels, held) on the paid route only, the count drops by what the
// open consumed, and a refusal re-reads it. The count is keyed to the signed-in
// customer and read on the client only, so a press never uses a stale count.
// The real machine renders here; only its theater (reel, reveal, sound,
// motion) is stubbed. The real roll-batch seam runs, spied for the request.

const mocks = vi.hoisted(() => ({
  customer: { id: 'cus_1' } as { id: string } | null,
  getPackGifts: vi.fn(),
  openBatch: vi.fn(),
  spinTaskReward: vi.fn(),
}));

const rollSpy = vi.hoisted(() => ({
  fn: null as null | ReturnType<typeof vi.fn>,
}));

vi.mock('@/lib/roll-batch', async (orig) => {
  const actual = await orig<typeof import('@/lib/roll-batch')>();
  rollSpy.fn = vi.fn(actual.rollBatch);
  return { ...actual, rollBatch: rollSpy.fn };
});
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) =>
    createElement('a', { href }, children),
}));
vi.mock('motion/react', () => ({
  motion: {
    div: ({
      children,
      className,
    }: {
      children: ReactNode;
      className?: string;
    }) => createElement('div', { className }, children),
  },
}));
vi.mock('@/lib/use-reveal', () => ({
  useMediaQuery: () => false,
  usePrefersReducedMotion: () => true,
}));
vi.mock('@/lib/use-chrome-inert', () => ({ useChromeInert: () => {} }));
vi.mock('@/components/auth/AuthProvider', () => ({
  useAuth: () => ({ customer: mocks.customer, isLoading: false }),
}));
vi.mock('@/components/AuthButton', () => ({ openAuth: vi.fn() }));
vi.mock('@/lib/actions/packs', () => ({
  openBatch: mocks.openBatch,
  openPack: vi.fn(),
  revealPull: vi.fn(),
  closeInstantWindow: vi.fn(),
}));
vi.mock('@/lib/actions/tasks', () => ({
  spinTaskReward: mocks.spinTaskReward,
}));
vi.mock('@/lib/actions/pack-gifts', () => ({
  getPackGifts: mocks.getPackGifts,
}));
vi.mock('@/lib/actions/vault', () => ({ sellBackPull: vi.fn() }));
vi.mock('@/components/app-shell/TopUpProvider', () => ({
  useTopUp: () => ({
    balance: 5000,
    applyBalance: vi.fn(),
    refreshBalance: vi.fn(async () => {}),
  }),
}));
vi.mock('@/components/app-shell/VaultDotProvider', () => ({
  useVaultDot: () => ({ refresh: vi.fn() }),
}));
vi.mock('@/lib/use-sound', () => ({
  useSound: () => ({
    muted: false,
    toggleMuted: vi.fn(),
    play: vi.fn(),
    playReveal: vi.fn(),
    vibrate: vi.fn(),
    sfx: vi.fn(),
  }),
}));
vi.mock('@/lib/pixel', () => ({ trackPixel: vi.fn() }));
vi.mock('../SlotReelStack', () => ({ SlotReelStack: () => null }));
vi.mock('../RevealStage', () => ({ RevealStage: () => null }));
vi.mock('../SlotStatusBar', () => ({ SlotStatusBar: () => null }));
vi.mock('../OddsSheet', () => ({ OddsSheet: () => null }));
vi.mock('../Meter', () => ({
  Meter: ({ value }: { value: number }) =>
    createElement('span', null, `RM${value.toFixed(2)}`),
}));
vi.mock('../VaultRoom', () => ({
  VaultRoom: ({ children }: { children: ReactNode }) =>
    createElement('div', null, children),
}));
vi.mock('../SlotControls', () => ({
  SlotControls: (p: {
    costLine: ReactNode;
    label: string;
    disabled: boolean;
    onSpin: () => void;
  }) =>
    createElement(
      'div',
      null,
      createElement('div', { 'data-testid': 'cost' }, p.costLine),
      createElement(
        'button',
        { type: 'button', disabled: p.disabled, onClick: p.onSpin },
        p.label,
      ),
    ),
}));
vi.mock('@/components/ui/SuccessToast', () => ({ SuccessToast: () => null }));

const SlotMachineClient = (await import('../SlotMachineClient')).default;

// Stable, as the server prop is: the `pool = []` default is a new array per
// render, which re-fires the idle decoy reshuffle forever.
const POOL: PackCard[] = [];

const BRONZE: ResolvedPack & Pack = {
  id: 'bronze',
  name: 'Bronze Pack',
  priceMyr: 300,
  image: '/images/polycards/bronze-pack.webp',
  categoryId: 'pokemon',
  categoryName: 'Pokémon',
  icon: 'pokemon',
};

const gift = (count: number) => ({
  packId: 'bronze',
  count,
  title: 'Bronze Pack',
  image: null,
  price: 300,
  available: true,
});

const roll = (i: number) => ({
  card: {
    handle: `card-${i}`,
    name: 'Pikachu',
    rarity: 'Common',
    priceMyr: 10,
    image: '/x.webp',
    pokemonDex: 25,
    spriteImage: null,
  },
  pullId: `pull_${i}`,
  marketValue: 2,
  buyback: null,
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
  mocks.customer = { id: 'cus_1' };
  mocks.getPackGifts.mockReset();
  mocks.openBatch.mockReset();
  mocks.spinTaskReward.mockReset();
  rollSpy.fn!.mockClear();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(
  props: {
    count?: number;
    freeRipClaimId?: string;
  } = {},
) {
  await act(async () => {
    root.render(
      createElement(SlotMachineClient, {
        pack: BRONZE,
        recentPulls: [],
        count: props.count ?? 1,
        publishedOdds: null,
        pool: POOL,
        freeRipClaimId: props.freeRipClaimId ?? null,
      }),
    );
  });
}

const cost = () =>
  container.querySelector('[data-testid="cost"]')?.textContent ?? '';
const spinButton = () =>
  [...container.querySelectorAll('button')].find((b) =>
    /Spin|Open/.test(b.textContent ?? ''),
  )!;
const press = () => act(async () => spinButton().click());

describe('SlotMachineClient — vault packs', () => {
  test('Spin waits for the one client read of the gifts', async () => {
    let resolve: (v: unknown) => void = () => {};
    mocks.getPackGifts.mockReturnValue(new Promise((r) => (resolve = r)));
    await render();
    expect(spinButton().disabled).toBe(true);
    await act(async () => resolve([gift(1)]));
    expect(cost()).toBe('Bet Vault x1');
    expect(spinButton().disabled).toBe(false);
    expect(mocks.getPackGifts).toHaveBeenCalledTimes(1);
  });

  test('a paid press sends gifts = min(reels, held); the count drops by what it used', async () => {
    mocks.getPackGifts.mockResolvedValue([gift(3)]);
    mocks.openBatch.mockResolvedValue({
      ok: true,
      rolls: [roll(0), roll(1)],
      price: 300,
      total: 0,
      balance: 5000,
      giftsUsed: 2,
    });
    await render({ count: 2 });
    expect(cost()).toBe('Bet Vault x2');
    await press();
    expect(mocks.openBatch).toHaveBeenCalledWith('bronze', 2, 2);
    expect(rollSpy.fn!.mock.calls[0]![0].gifts).toBe(2);
    expect(cost()).toBe('Bet Vault x1 + RM300.00');
  });

  test('more reels than gifts: only the gifts held are sent', async () => {
    mocks.getPackGifts.mockResolvedValue([gift(1)]);
    mocks.openBatch.mockResolvedValue({ ok: false, error: 'nope' });
    await render({ count: 3 });
    await press();
    expect(mocks.openBatch).toHaveBeenCalledWith('bronze', 3, 1);
  });

  test('a free rip sends 0 gifts and never touches openBatch', async () => {
    mocks.getPackGifts.mockResolvedValue([gift(2)]);
    mocks.spinTaskReward.mockResolvedValue({ ok: false, error: 'gone' });
    await render({ freeRipClaimId: 'claim_1' });
    expect(cost()).not.toContain('Vault');
    await press();
    expect(rollSpy.fn!.mock.calls[0]![0].gifts).toBe(0);
    expect(mocks.spinTaskReward).toHaveBeenCalledWith('claim_1');
    expect(mocks.openBatch).not.toHaveBeenCalled();
  });

  test('a stale-gift refusal re-reads the count', async () => {
    mocks.getPackGifts
      .mockResolvedValueOnce([gift(1)])
      .mockResolvedValueOnce([]);
    mocks.openBatch.mockResolvedValue({
      ok: false,
      error: 'Your vault pack is no longer available — refresh.',
      staleGifts: true,
    });
    await render();
    expect(cost()).toBe('Bet Vault x1');
    await press();
    expect(mocks.getPackGifts).toHaveBeenCalledTimes(2);
    expect(cost()).toBe('Bet RM300.00');
    expect(container.textContent).toContain(
      'Your vault pack is no longer available',
    );
  });

  test('a failed read settles at 0 with a Retry that re-reads', async () => {
    mocks.getPackGifts
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce([gift(1)]);
    await render();
    // Paid spins are not blocked by an outage: full price, Spin enabled.
    expect(cost()).toBe('Bet RM300.00');
    expect(spinButton().disabled).toBe(false);
    expect(container.textContent).toContain("Couldn't check your vault packs");
    const retry = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === 'Retry',
    )!;
    await act(async () => retry.click());
    expect(mocks.getPackGifts).toHaveBeenCalledTimes(2);
    expect(cost()).toBe('Bet Vault x1');
    expect(container.textContent).not.toContain('Couldn');
  });

  test('an account switch re-reads for the new customer before a press', async () => {
    mocks.getPackGifts
      .mockResolvedValueOnce([gift(1)])
      .mockReturnValueOnce(new Promise(() => {}));
    await render();
    expect(cost()).toBe('Bet Vault x1');
    mocks.customer = { id: 'cus_2' };
    await render();
    expect(mocks.getPackGifts).toHaveBeenCalledTimes(2);
    // cus_1's count is never shown or used for cus_2.
    expect(cost()).toBe('Bet RM300.00');
    expect(spinButton().disabled).toBe(true);
  });
});

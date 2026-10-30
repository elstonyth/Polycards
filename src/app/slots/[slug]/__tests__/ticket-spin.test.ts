// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  ticketCard,
  type Pack,
  type PackCard,
  type ResolvedPack,
} from '@/lib/packs-data';

// A customer on a ticket pack spins the machine they already know and lands on
// a ticket instead of a slab: nothing to sell, nothing to keep, and no clock
// that clears the screen under them. The real machine, the real roll seam and
// the real reveal run; the reel stub reports what it was asked to land on and
// settles at once. The backend's own settle is proved in its own lane.

const mocks = vi.hoisted(() => ({
  customer: { id: 'cus_1' } as { id: string } | null,
  openBatch: vi.fn(),
  refreshVaultDot: vi.fn(),
  playReveal: vi.fn(),
  vibrate: vi.fn(),
}));

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) =>
    createElement('a', { href }, children),
}));
vi.mock('next/image', () => ({
  default: ({ alt, src }: { alt: string; src: string }) =>
    createElement('img', { alt, src }),
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
vi.mock('@/lib/actions/tasks', () => ({ spinTaskReward: vi.fn() }));
vi.mock('@/lib/actions/pack-gifts', () => ({ getPackGifts: async () => [] }));
vi.mock('@/lib/actions/vault', () => ({ sellBackPull: vi.fn() }));
vi.mock('@/components/app-shell/TopUpProvider', () => ({
  useTopUp: () => ({
    balance: 5000,
    applyBalance: vi.fn(),
    refreshBalance: vi.fn(async () => {}),
  }),
}));
vi.mock('@/components/app-shell/VaultDotProvider', () => ({
  useVaultDot: () => ({ refresh: mocks.refreshVaultDot }),
}));
vi.mock('@/lib/use-sound', () => ({
  useSound: () => ({
    muted: false,
    toggleMuted: vi.fn(),
    play: vi.fn(),
    playReveal: mocks.playReveal,
    vibrate: mocks.vibrate,
    sfx: vi.fn(),
  }),
}));
vi.mock('@/lib/pixel', () => ({ trackPixel: vi.fn() }));
vi.mock('../SlotReelStack', async () => {
  const { useEffect, createElement: h } = await import('react');
  return {
    SlotReelStack: (p: {
      winners: { label?: string }[] | null;
      onAllSettled?: () => void;
    }) => {
      const { winners, onAllSettled } = p;
      useEffect(() => {
        if (winners) onAllSettled?.();
      }, [winners, onAllSettled]);
      return h(
        'div',
        { 'data-testid': 'reels' },
        winners?.map((w) => w.label).join(','),
      );
    },
  };
});
vi.mock('../RevealStage', () => ({
  RevealStage: () => createElement('div', null, 'SLAB STAGE'),
}));
vi.mock('../SlotStatusBar', () => ({
  SlotStatusBar: ({ recent }: { recent: unknown[] }) =>
    createElement('div', { 'data-testid': 'recent' }, String(recent.length)),
}));
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
        {
          type: 'button',
          disabled: p.disabled,
          onClick: p.onSpin,
          'data-testid': 'machine-spin',
        },
        p.label,
      ),
    ),
}));
vi.mock('@/components/ui/SuccessToast', () => ({ SuccessToast: () => null }));

const SlotMachineClient = (await import('../SlotMachineClient')).default;

// Stable, as the server prop is (see spin-vault-packs.test.ts).
const POOL: PackCard[] = [ticketCard(10, 'Common'), ticketCard(100, 'Rare')];

const LUCKY: ResolvedPack & Pack = {
  id: 'lucky-pack',
  name: 'Lucky Pack',
  priceMyr: 10,
  image: '/images/polycards/lucky-pack.webp',
  categoryId: 'poly',
  categoryName: 'Poly',
  icon: '/pack-index-icons/poly.webp',
  prizeType: 'tickets',
};

const ticketBatch = (...amounts: number[]) => ({
  ok: true,
  rolls: amounts.map((n) => ({
    card: ticketCard(n, n >= 1000 ? 'Immortal' : 'Rare'),
    pullId: null,
    marketValue: 0,
    buyback: null,
  })),
  price: 10,
  total: 10 * amounts.length,
  balance: 4990,
  giftsUsed: 0,
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
  mocks.openBatch.mockReset();
  mocks.refreshVaultDot.mockReset();
  mocks.playReveal.mockReset();
  mocks.vibrate.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 5));
  });

async function render(props: { count?: number; demo?: boolean } = {}) {
  await act(async () => {
    root.render(
      createElement(SlotMachineClient, {
        pack: LUCKY,
        recentPulls: [],
        count: props.count ?? 1,
        publishedOdds: null,
        pool: POOL,
        demoPool: props.demo ? POOL : null,
      }),
    );
  });
  await settle();
}

const byTestId = (id: string) =>
  container.querySelector(`[data-testid="${id}"]`)!;
// Enabled only: the machine's own Spin also reads "Spin again", locked here.
const buttonNamed = (name: string) =>
  [...container.querySelectorAll('button')].find(
    (b) => b.textContent === name && !b.disabled,
  );
const spin = async () => {
  await act(async () => (byTestId('machine-spin') as HTMLElement).click());
  await settle();
};

describe('SlotMachineClient — ticket pack', () => {
  test('lands on a ticket, not a slab, with nothing to sell or keep', async () => {
    mocks.openBatch.mockResolvedValue(ticketBatch(100));
    await render();
    await spin();

    expect(mocks.openBatch).toHaveBeenCalledTimes(1);
    expect(mocks.openBatch).toHaveBeenCalledWith('lucky-pack', 1, 0);
    expect(byTestId('reels').textContent).toBe('x100');

    const text = container.textContent ?? '';
    expect(text).toContain('100 tickets');
    expect(text).not.toContain('SLAB STAGE');
    expect(text).not.toMatch(/sell|keep in vault/i);
    const link = container.querySelector('a[href="/lucky-draw"]');
    expect(link?.textContent).toBe('Go to Lucky Draw');
    expect(buttonNamed('Spin again')).toBeDefined();
  });

  test('the row rarity drives the reveal sound', async () => {
    mocks.openBatch.mockResolvedValue(ticketBatch(1000));
    await render();
    await spin();
    expect(mocks.playReveal).toHaveBeenCalledTimes(1);
    expect(mocks.playReveal).toHaveBeenCalledWith(['Immortal']);
  });

  // RevealStage clears itself once every card is concluded, and a reveal with
  // no offers reads as concluded at once. This one waits for the customer.
  test('never concludes on its own', async () => {
    mocks.openBatch.mockResolvedValue(ticketBatch(100));
    await render();
    await spin();
    vi.useFakeTimers();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(container.textContent).toContain('100 tickets');
  });

  // The only charge is a press of the machine's Spin. The reveal's button goes
  // back to the machine and never reaches the server on its own.
  test('Spin again returns to the machine, whose Spin charges once more', async () => {
    mocks.openBatch.mockResolvedValue(ticketBatch(100));
    await render();
    await spin();

    await act(async () => buttonNamed('Spin again')!.click());
    await settle();
    expect(mocks.openBatch).toHaveBeenCalledTimes(1);
    // The reveal's own controls: the screen-reader status keeps its text until
    // the next roll, on a card pack too.
    expect(container.querySelector('a[href="/lucky-draw"]')).toBeNull();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 650)); // the machine's cooldown
    });
    expect((byTestId('machine-spin') as HTMLButtonElement).disabled).toBe(
      false,
    );

    await spin();
    expect(mocks.openBatch).toHaveBeenCalledTimes(2);
  });

  test('three reels show three tickets and their total', async () => {
    mocks.openBatch.mockResolvedValue(ticketBatch(10, 50, 1000));
    await render({ count: 3 });
    await spin();
    expect(byTestId('reels').textContent).toBe('x10,x50,x1000');
    const text = container.textContent ?? '';
    expect(text).toContain('10 tickets');
    expect(text).toContain('50 tickets');
    expect(text).toContain('1,000 tickets');
    expect(text).toContain('1,060 tickets');
  });

  test('stays out of the recent pulls and the vault dot', async () => {
    mocks.openBatch.mockResolvedValue(ticketBatch(100));
    await render();
    await spin();
    expect(byTestId('recent').textContent).toBe('0');
    expect(mocks.refreshVaultDot).not.toHaveBeenCalled();
  });

  test('announces the tickets to a screen reader', async () => {
    mocks.openBatch.mockResolvedValue(ticketBatch(10, 50));
    await render({ count: 2 });
    await spin();
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      'Won 60 tickets',
    );
  });

  test('a guest demo samples the rows, charges nothing and offers a sign-up', async () => {
    mocks.customer = null;
    await render({ demo: true });
    expect(byTestId('cost').textContent).toContain('no real tickets won');
    await spin();

    expect(mocks.openBatch).not.toHaveBeenCalled();
    const text = container.textContent ?? '';
    expect(text).toMatch(/\b(10|100) tickets\b/);
    expect(text).not.toContain('Go to Lucky Draw');
    expect(buttonNamed('Sign up & spin for real')).toBeDefined();

    await act(async () => buttonNamed('Back to the reel')!.click());
    await settle();
    expect(buttonNamed('Back to the reel')).toBeUndefined();
  });

  test('the flood beat shows nothing yet, then the ticket and its sound, once', async () => {
    const playReveal = vi.fn();
    const vibrate = vi.fn();
    const props = {
      cards: [ticketCard(1000, 'Immortal')],
      reduced: false,
      demo: false,
      onSkip: vi.fn(),
      onConclude: vi.fn(),
      playReveal,
      vibrate,
    };
    const { TicketReveal } = await import('../TicketReveal');
    const show = (phase: 'flood' | 'transform' | 'review') =>
      act(async () => {
        root.render(createElement(TicketReveal, { ...props, phase }));
      });

    await show('flood');
    expect(container.textContent).not.toContain('tickets');
    expect(playReveal).not.toHaveBeenCalled();

    await show('transform');
    await show('review');
    expect(container.textContent).toContain('1,000 tickets');
    expect(playReveal).toHaveBeenCalledTimes(1);
    expect(vibrate).toHaveBeenCalledWith([40, 40, 80]);
  });

  test('the control: a card roll still goes to the slab stage', async () => {
    mocks.openBatch.mockResolvedValue({
      ok: true,
      rolls: [
        {
          card: {
            handle: 'pikachu',
            name: 'Pikachu',
            rarity: 'Common',
            priceMyr: 10,
            image: '/x.webp',
            slabImage: null,
            pokemonDex: 25,
            spriteImage: null,
          },
          pullId: 'pull_1',
          marketValue: 2,
          buyback: null,
        },
      ],
      price: 10,
      total: 10,
      balance: 4990,
      giftsUsed: 0,
    });
    await render();
    await spin();
    expect(container.textContent).toContain('SLAB STAGE');
    expect(container.textContent).not.toContain('Go to Lucky Draw');
    expect(byTestId('recent').textContent).toBe('1');
    expect(mocks.refreshVaultDot).toHaveBeenCalled();
  });
});

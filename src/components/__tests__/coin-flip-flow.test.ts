// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CoinFlipRound } from '@/lib/coin-flip';
import type { VaultResult } from '@/lib/actions/vault';
const mocks = vi.hoisted(() => ({
  quote: vi.fn(),
  accept: vi.fn(),
  read: vi.fn(),
  refresh: vi.fn(),
  vault: vi.fn(),
  settings: vi.fn(),
}));
vi.mock('@/lib/actions/coin-flip', () => ({
  quoteCoinFlip: mocks.quote,
  acceptCoinFlip: mocks.accept,
  getCoinFlipRound: mocks.read,
  getCoinFlipSettings: mocks.settings,
}));
vi.mock('@/lib/actions/vault', () => ({ getVault: mocks.vault }));
vi.mock('@/components/app-shell/TopUpProvider', () => ({
  useTopUp: () => ({ refreshBalance: mocks.refresh }),
}));
vi.mock('@/components/coin-flip/StaticCoin', () => ({
  StaticCoin: () => null,
}));
vi.mock('@/components/coin-flip/CoinStage', () => ({ CoinStage: () => null }));
vi.mock('@/components/coin-flip/CoinFlipHistory', () => ({
  CoinFlipHistory: () => null,
}));
vi.mock('next/image', () => ({ default: () => null }));
import { CoinFlipClient } from '@/app/(account)/vault/coin-flip/CoinFlipClient';
import { VaultActionBar } from '@/components/account/VaultActionBar';
vi.mock('@/lib/use-counted-value', () => ({
  useCountedValue: (value: number) => ({ value }),
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const round: CoinFlipRound = {
  id: 'cfr_test',
  status: 'quoted',
  expires_at: '2099-01-01T00:00:00.000Z',
  settled_at: null,
  stake_amount: 100,
  win_amount: 0,
  published_win_percent: 50,
  card: {
    pull_id: 'p1',
    name: 'Pikachu',
    image: null,
    grader: 'PSA',
    grade: '10',
  },
};
const vault: VaultResult = {
  ok: true,
  balance: 0,
  items: [
    {
      pullId: 'p1',
      rolledAt: '',
      packId: '',
      packTitle: '',
      challengePrize: false,
      showcased: false,
      source: 'gift',
      locked: false,
      sellable: true,
      card: {
        handle: 'pika',
        name: 'Pikachu',
        image: '',
        slabImage: null,
        rarity: null,
        priceMyr: 100,
        pokemonDex: null,
        spriteImage: null,
      },
      buyback: { percent: 90, amount: 90, firm: true, bonus: 90 },
    },
  ],
};
const settings = {
  ok: true as const,
  settings: {
    enabled: true,
    eligible: true,
    reason: null,
    max_stake_amount: 1000,
    published_win_percent: 50,
  },
};
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  window.history.replaceState({}, '', '/vault/coin-flip');
  mocks.quote.mockResolvedValue({ ok: true, round });
  mocks.refresh.mockResolvedValue(undefined);
  mocks.vault.mockResolvedValue(vault);
  mocks.settings.mockResolvedValue(settings);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
async function render() {
  await act(async () => {
    root.render(
      createElement(CoinFlipClient, {
        customerId: 'c1',
        initialVault: vault,
        initialSettings: settings,
        initialPullId: 'p1',
      }),
    );
  });
}
function button(name: string) {
  const el = [...document.querySelectorAll('button')].find(
    (b) => b.textContent === name,
  );
  expect(el, name).toBeTruthy();
  return el!;
}
async function click(name: string) {
  await act(async () => {
    button(name).click();
  });
}

describe('coin flip confirmation and recovery', () => {
  it('allows exactly one selected card in the Vault entry', () => {
    const props = {
      selectedCount: 2,
      sellableCount: 2,
      visibleCount: 2,
      allVisibleSelected: true,
      fmv: 200,
      sellTotal: 180,
      quotesFirm: true,
      busy: false,
      onToggleSelectAll: vi.fn(),
      onSell: vi.fn(),
      onDeliver: vi.fn(),
      onCoinFlip: vi.fn(),
    };
    act(() => root.render(createElement(VaultActionBar, props)));
    expect(button('Select one card to coin flip').disabled).toBe(true);
    act(() =>
      root.render(
        createElement(VaultActionBar, { ...props, selectedCount: 1 }),
      ),
    );
    expect(button('Coin flip').disabled).toBe(false);
  });
  it('cancel never accepts; confirming only arms the coin', async () => {
    await render();
    await click('Review card & odds');
    expect(document.querySelector('[role=dialog]')?.textContent).toContain(
      'permanently forfeited',
    );
    await click('Cancel');
    expect(mocks.accept).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(button('Review card & odds'));
    await click('Review card & odds');
    await click('Confirm card');
    expect(mocks.accept).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(button('Flip coin'));
  });
  it('double press submits one ID, a win never auto-stakes again', async () => {
    let resolve!: (v: unknown) => void;
    mocks.accept.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    await render();
    await click('Review card & odds');
    await click('Confirm card');
    const flip = button('Flip coin');
    act(() => {
      flip.click();
      flip.click();
    });
    expect(mocks.accept).toHaveBeenCalledExactlyOnceWith(round.id);
    expect(localStorage.getItem('polycards:coin-flip:c1')).toBe(round.id);
    await act(async () =>
      resolve({
        ok: true,
        round: { ...round, status: 'won', win_amount: 100 },
      }),
    );
    expect(host.textContent).toContain('Coin in flight');
    await click('Skip animation');
    expect(host.textContent).toContain('+RM 100.00');
    expect(localStorage.getItem('polycards:coin-flip:c1')).toBeNull();
    await click('Choose a card');
    expect(button('Review card & odds').disabled).toBe(true);
    expect(mocks.quote).toHaveBeenCalledTimes(1);
  });
  it('lost response recovers original win without resubmitting', async () => {
    mocks.accept.mockRejectedValue(new Error('timeout'));
    mocks.read.mockResolvedValue({
      ok: true,
      round: { ...round, status: 'won', win_amount: 100 },
    });
    await render();
    await click('Review card & odds');
    await click('Confirm card');
    await click('Flip coin');
    expect(host.textContent).toContain('result is unknown');
    await click('Check result');
    expect(host.textContent).toContain('+RM 100.00');
    expect(mocks.accept).toHaveBeenCalledTimes(1);
  });
  it('mount recovers customer-scoped pending ID before a new card', async () => {
    localStorage.setItem('polycards:coin-flip:c1', round.id);
    mocks.read.mockResolvedValue({ ok: true, round });
    await render();
    expect(mocks.read).toHaveBeenCalledWith(round.id);
    expect(host.textContent).toContain('Retry same flip');
    expect(mocks.quote).not.toHaveBeenCalled();
    mocks.accept.mockResolvedValue({
      ok: false,
      uncertain: false,
      error: 'Quote expired. Review your card again.',
    });
    await click('Retry same flip');
    expect(localStorage.getItem('polycards:coin-flip:c1')).toBeNull();
    expect(button('Review card & odds')).toBeTruthy();
    expect(mocks.quote).not.toHaveBeenCalled();
  });
  it('a confirmed missing receipt clears recovery without staking', async () => {
    localStorage.setItem('polycards:coin-flip:c1', 'missing');
    mocks.read.mockResolvedValue({
      ok: false,
      uncertain: false,
      missing: true,
      error: 'This flip could not be found.',
    });
    await render();
    expect(localStorage.getItem('polycards:coin-flip:c1')).toBeNull();
    expect(button('Review card & odds').disabled).toBe(false);
    expect(mocks.accept).not.toHaveBeenCalled();
  });
});

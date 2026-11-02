// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CoinFlipRound } from '@/lib/coin-flip';
import type { VaultResult } from '@/lib/actions/vault';
const mocks = vi.hoisted(() => ({
  quote: vi.fn(),
  tickets: vi.fn(),
  accept: vi.fn(),
  read: vi.fn(),
  refresh: vi.fn(),
  vault: vi.fn(),
  settings: vi.fn(),
  scene: vi.fn(),
  history: vi.fn(),
  scroll: vi.fn(),
  sfx: vi.fn(),
  vibrate: vi.fn(),
  duck: vi.fn(),
}));
vi.mock('@/lib/use-sound', () => ({
  useSound: () => ({
    sfx: mocks.sfx,
    vibrate: mocks.vibrate,
    duck: mocks.duck,
  }),
}));
vi.mock('@/lib/actions/coin-flip', () => ({
  quoteCoinFlip: mocks.quote,
  acceptCoinFlip: mocks.accept,
  getCoinFlipRound: mocks.read,
  getCoinFlipSettings: mocks.settings,
}));
vi.mock('@/lib/actions/vault', () => ({ getVault: mocks.vault }));
vi.mock('@/lib/actions/lucky-draw', () => ({
  getTicketBalance: mocks.tickets,
}));
vi.mock('@/components/app-shell/TopUpProvider', () => ({
  useTopUp: () => ({ refreshBalance: mocks.refresh }),
}));
vi.mock('@/components/coin-flip/StaticCoin', () => ({
  StaticCoin: () => null,
}));
vi.mock('@/components/coin-flip/CoinStage', () => ({
  CoinStage: (props: unknown) => {
    mocks.scene(props);
    return null;
  },
}));
vi.mock('@/components/coin-flip/CoinFlipHistory', () => ({
  CoinFlipHistory: (props: unknown) => {
    mocks.history(props);
    return null;
  },
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
  tickets: 0,
  chosen_side: 'head',
  landed_side: null,
  cards: [
    {
      pull_id: 'p1',
      name: 'Pikachu',
      image: null,
      grader: 'PSA',
      grade: '10',
      stake_amount: 100,
    },
  ],
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
      luckyDrawPrize: false,
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
  mocks.tickets.mockResolvedValue(null);
  host = document.createElement('div');
  host.ownerDocument.defaultView!.HTMLElement.prototype.scrollIntoView =
    mocks.scroll;
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
  // The page re-reads its stake on mount; the tests count what comes after.
  mocks.vault.mockClear();
  mocks.tickets.mockClear();
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
    button(name).focus();
    button(name).click();
  });
}

describe('coin flip confirmation and recovery', () => {
  it.each(['won', 'lost'] as const)(
    'commits one Tail call for multiple selected cards and shows the correct %s face',
    async (status) => {
      const extra = {
        ...vault.items[0]!,
        pullId: 'p2',
        card: { ...vault.items[0]!.card, name: 'Eevee', priceMyr: 75 },
      };
      const bundle: CoinFlipRound = {
        ...round,
        chosen_side: 'tail',
        stake_amount: 175,
        cards: [
          ...round.cards,
          { ...round.card!, pull_id: 'p2', name: 'Eevee', stake_amount: 75 },
        ],
      };
      mocks.quote.mockResolvedValue({ ok: true, round: bundle });
      mocks.accept.mockResolvedValue({
        ok: true,
        round: {
          ...bundle,
          status,
          landed_side: status === 'won' ? 'tail' : 'head',
          win_amount: status === 'won' ? 175 : 0,
        },
      });
      mocks.vault.mockResolvedValue({
        ...vault,
        items: [...vault.items, extra],
      });
      await act(async () =>
        root.render(
          createElement(CoinFlipClient, {
            customerId: 'c1',
            initialVault: { ...vault, items: [...vault.items, extra] },
            initialSettings: settings,
            initialPullId: 'p1',
          }),
        ),
      );
      mocks.vault.mockClear();
      await click('Edit selection');
      await act(async () =>
        document
          .querySelector<HTMLButtonElement>(
            'button[aria-label="Select Eevee, RM 75.00"]',
          )!
          .click(),
      );
      expect(document.querySelector('[role=dialog]')?.textContent).toContain(
        '2 selected · RM 175.00',
      );
      await click('Use 2 cards');
      await act(async () =>
        document
          .querySelector<HTMLInputElement>('input[value="tail"]')!
          .click(),
      );
      await click('Review cards');
      expect(mocks.quote).toHaveBeenCalledWith(['p1', 'p2'], 'tail', 0);
      expect(document.querySelector('[role=dialog]')?.textContent).toContain(
        'Every selected card is permanently forfeited',
      );
      await click('Confirm 2 cards · Tail');
      expect(mocks.scene.mock.lastCall?.[0]).toMatchObject({
        side: 'tail',
        armed: true,
        outcome: null,
      });
      // The call is locked once confirmed: the side picker is gone.
      expect(document.querySelector('input[value="head"]')).toBeNull();
      const flip = button('Flip coin');
      expect(mocks.scroll).toHaveBeenCalledExactlyOnceWith({
        block: 'start',
        behavior: 'instant',
      });
      const coinView = mocks.scroll.mock.contexts[0] as HTMLElement;
      expect(
        coinView.contains(
          document.querySelector('[aria-label="Cards in this flip"]'),
        ),
      ).toBe(true);
      expect(coinView.textContent).toContain('Your call: Tail');
      await act(async () => {
        flip.click();
        flip.click();
      });
      expect(mocks.accept).toHaveBeenCalledTimes(1);
      expect(mocks.scroll).toHaveBeenCalledTimes(2);
      expect(mocks.scene.mock.lastCall?.[0]).toMatchObject({
        side: status === 'won' ? 'tail' : 'head',
        outcome: status,
        // In the air: playing this round, and no winner's light until it lands.
        revealed: false,
        playbackId: round.id,
      });
      const mobileStake = document.querySelector(
        '[aria-label="Cards in this flip"]',
      );
      expect(mobileStake?.textContent).toContain('Pikachu');
      expect(mobileStake?.textContent).toContain('Eevee');
      expect(mobileStake?.textContent).toContain('RM 175.00');
      expect(coinView.textContent).toContain('Your call: Tail');
      // The landed face, the Credit won and the cards lost stay hidden until the coin has landed.
      for (const early of [
        'Landed:',
        'Keep cards +',
        'All cards forfeited',
        'Cards forfeited',
        '+RM',
        'You won',
        'Flip lost',
      ])
        expect(host.textContent).not.toContain(early);
      expect(mocks.refresh).not.toHaveBeenCalled();
      expect(mocks.vault).not.toHaveBeenCalled();
      expect(mocks.history.mock.lastCall?.[0]).toMatchObject({
        refresh: 0,
        paused: true,
      });
      // The coin's flick replaces the site-wide button click.
      expect(flip.getAttribute('data-sound')).toBe('off');
      expect(mocks.sfx).not.toHaveBeenCalled();
      await click('Skip animation');
      // One result cue, after the landing, with the music held down under it.
      expect(mocks.sfx).toHaveBeenCalledExactlyOnceWith(
        status === 'won' ? 'coinWin' : 'coinLoss',
      );
      expect(mocks.duck).toHaveBeenCalledWith(true);
      expect(mocks.scene.mock.lastCall?.[0]).toMatchObject({ revealed: true });
      expect(mocks.refresh).toHaveBeenCalledTimes(1);
      expect(mocks.vault).toHaveBeenCalledTimes(1);
      expect(mocks.history.mock.lastCall?.[0]).toMatchObject({
        refresh: 1,
        paused: false,
      });
      expect(mobileStake?.textContent).toContain('RM 175.00');
      expect(coinView.textContent).toContain('Your call: Tail');
      expect(coinView.textContent).toContain(
        status === 'won' ? 'Landed: Tail' : 'Landed: Head',
      );
      expect(host.textContent).toContain(
        status === 'won' ? 'Tail landed · You won' : 'Head landed · Flip lost',
      );
      expect(host.textContent).toContain(
        status === 'won' ? '+RM 175.00' : 'Cards forfeited',
      );
    },
  );

  it('allows high-value cards to be selected together without a stake cap', async () => {
    const extra = {
      ...vault.items[0]!,
      pullId: 'p2',
      card: { ...vault.items[0]!.card, name: 'Eevee', priceMyr: 50000 },
    };
    mocks.vault.mockResolvedValue({
      ...vault,
      items: [...vault.items, extra],
    });
    await act(async () =>
      root.render(
        createElement(CoinFlipClient, {
          customerId: 'c1',
          initialPullId: 'p1',
          initialVault: { ...vault, items: [...vault.items, extra] },
          initialSettings: settings,
        }),
      ),
    );
    await click('Edit selection');
    const extraButton = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Select Eevee, RM 50,000.00"]',
    )!;
    expect(extraButton.disabled).toBe(false);
    await act(async () => extraButton.click());
    await click('Use 2 cards');
    expect(
      document.querySelector('[aria-label="Selected cards"]')?.textContent,
    ).toContain('RM 50,100.00');
    expect(mocks.accept).not.toHaveBeenCalled();
  });
  it('focuses review after selecting from an initially empty card panel', async () => {
    await act(async () =>
      root.render(
        createElement(CoinFlipClient, {
          customerId: 'c1',
          initialVault: vault,
          initialSettings: settings,
        }),
      ),
    );
    const trigger = [...document.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Choose from Vault'),
    )!;
    await act(async () => {
      trigger.focus();
      trigger.click();
    });
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Select Pikachu, RM 100.00"]',
        )!
        .click(),
    );
    await click('Use 1 card');
    expect(document.activeElement).toBe(button('Review cards'));
    expect(mocks.quote).not.toHaveBeenCalled();
  });
  it('opens a visual Vault picker, selects a card and restores focus without committing', async () => {
    await render();
    expect(document.querySelector('select')).toBeNull();
    await click('Edit selection');
    expect(document.querySelector('[role=dialog]')?.textContent).toContain(
      'Choose from your Vault',
    );
    const card = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Select Pikachu, RM 100.00"]',
    );
    expect(card).toBeTruthy();
    expect(card!.getAttribute('aria-pressed')).toBe('true');
    await click('Use 1 card');
    expect(document.querySelector('[role=dialog]')).toBeNull();
    expect(
      document.querySelector('[aria-label="Selected cards"]')?.textContent,
    ).toContain('Pikachu');
    expect(document.activeElement).toBe(button('Edit selection'));
    expect(mocks.quote).not.toHaveBeenCalled();
    expect(mocks.accept).not.toHaveBeenCalled();
  });
  it('allows up to 20 selected cards in the Vault entry', () => {
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
    expect(button('Coin flip').disabled).toBe(false);
    act(() =>
      root.render(
        createElement(VaultActionBar, { ...props, selectedCount: 21 }),
      ),
    );
    expect(button('Select up to 20 cards to coin flip').disabled).toBe(true);
    act(() =>
      root.render(
        createElement(VaultActionBar, { ...props, selectedCount: 1 }),
      ),
    );
    expect(button('Coin flip').disabled).toBe(false);
  });
  it('cancel never accepts; confirming only arms the coin', async () => {
    await render();
    await click('Review cards');
    expect(document.querySelector('[role=dialog]')?.textContent).toContain(
      'permanently forfeited',
    );
    await click('Cancel');
    expect(mocks.accept).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(button('Review cards'));
    await click('Review cards');
    await click('Confirm card · Head');
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
    await click('Review cards');
    await click('Confirm card · Head');
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
        round: {
          ...round,
          status: 'won',
          landed_side: 'head',
          win_amount: 100,
        },
      }),
    );
    expect(host.textContent).toContain('Coin in flight');
    expect(mocks.refresh).not.toHaveBeenCalled();
    await act(async () => {
      mocks.scene.mock.lastCall?.[0].onComplete();
    });
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain('+RM 100.00');
    expect(localStorage.getItem('polycards:coin-flip:c1')).toBeNull();
    await click('Choose cards');
    expect(button('Review cards').disabled).toBe(true);
    expect(mocks.quote).toHaveBeenCalledTimes(1);
  });
  describe('tickets in a flip', () => {
    // What a sighted player reads: the count's word is for screen readers only.
    const visible = (el: Element | null | undefined) => {
      const copy = el!.cloneNode(true) as Element;
      copy.querySelectorAll('.sr-only').forEach((n) => n.remove());
      return copy.textContent;
    };
    const ticketsOnly: CoinFlipRound = {
      ...round,
      stake_amount: 0,
      card: null,
      cards: [],
      tickets: 5,
      chosen_side: 'tail',
    };
    const withCard: CoinFlipRound = {
      ...round,
      tickets: 5,
      chosen_side: 'tail',
    };
    const settledRound = (
      quote: CoinFlipRound,
      status: 'won' | 'lost',
    ): CoinFlipRound => ({
      ...quote,
      status,
      settled_at: '2026-10-30T07:00:00.000Z',
      landed_side: status === 'won' ? 'tail' : 'head',
      win_amount: status === 'won' ? quote.stake_amount : 0,
    });
    const amount = () =>
      document.querySelector<HTMLInputElement>(
        'input[aria-label="Tickets to flip"]',
      )!;
    const type = (value: string) =>
      act(async () => {
        const input = amount();
        Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          'value',
        )!.set!.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
    const open = (held: number | null, extra: Record<string, unknown> = {}) =>
      act(async () => {
        root.render(
          createElement(CoinFlipClient, {
            customerId: 'c1',
            initialVault: vault,
            initialSettings: settings,
            initialTickets: held,
            ...extra,
          }),
        );
      });
    const toss = async (
      quote: CoinFlipRound,
      status: 'won' | 'lost',
      after: number,
    ) => {
      mocks.quote.mockResolvedValue({ ok: true, round: quote });
      mocks.accept.mockResolvedValue({
        ok: true,
        round: settledRound(quote, status),
      });
      mocks.tickets.mockResolvedValue(after);
      await act(async () =>
        document
          .querySelector<HTMLInputElement>('input[value="tail"]')!
          .click(),
      );
      await click('Add');
      await type('5');
      await click(quote.cards.length ? 'Review flip' : 'Review tickets');
      await click(
        quote.cards.length
          ? 'Confirm card + 5 tickets · Tail'
          : 'Confirm 5 tickets · Tail',
      );
      await click('Flip coin');
      await act(async () => {
        mocks.scene.mock.lastCall?.[0].onComplete();
      });
    };
    const offered = (name: string) =>
      [...document.querySelectorAll('button')].some(
        (b) => b.textContent === name,
      );

    it('hides the amount with no tickets or an unreadable balance', async () => {
      for (const held of [0, null]) {
        await open(held, { initialPullId: 'p1' });
        expect(amount()).toBeNull();
        expect(button('Review cards')).toBeTruthy();
      }
    });
    it('starts at no tickets, so a card flip stays a card flip', async () => {
      await open(20, { initialPullId: 'p1' });
      expect(amount()).toBeNull();
      expect(host.textContent).toContain('You have 20');
      await click('Review cards');
      expect(mocks.quote).toHaveBeenCalledExactlyOnceWith(['p1'], 'head', 0);
      expect(document.querySelector('[role=dialog]')?.textContent).toContain(
        'Put this card on the line?',
      );
    });
    it('starts at one ticket when it came from the Vault tickets row', async () => {
      await open(20, { initialStake: 'tickets' });
      expect(amount().value).toBe('1');
      expect(button('Review tickets').disabled).toBe(false);
    });
    it('keeps the amount within what the player holds', async () => {
      await open(8);
      await click('Add');
      expect(amount().value).toBe('1');
      await type('999');
      expect(amount().value).toBe('8');
      await click('Max');
      expect(amount().value).toBe('8');
      await act(async () => amount().focus());
      await type('');
      expect(amount().value).toBe('');
      expect(button('Review cards').disabled).toBe(true);
      await type('3x');
      expect(amount().value).toBe('3');
      expect(button('Review tickets').disabled).toBe(false);
    });
    it('folds back to one line when the amount goes back to none', async () => {
      await open(8);
      await click('Add');
      await act(async () =>
        document
          .querySelector<HTMLButtonElement>(
            'button[aria-label="One ticket fewer"]',
          )!
          .click(),
      );
      expect(amount()).toBeNull();
      expect(button('Add')).toBeTruthy();
    });
    it('quotes tickets alone, with no RM or Credit anywhere on the sheet', async () => {
      await open(20);
      await click('Add');
      await type('5');
      mocks.quote.mockResolvedValue({ ok: true, round: ticketsOnly });
      await click('Review tickets');
      expect(mocks.quote).toHaveBeenCalledExactlyOnceWith([], 'head', 5);
      const dialog = document.querySelector('[role=dialog]')!.textContent;
      expect(dialog).toContain('Put 5 tickets on the line?');
      expect(dialog).toContain('5 tickets more');
      expect(dialog).toContain('All 5 tickets you flipped are gone');
      expect(dialog).not.toMatch(/RM|Credit/);
      expect(mocks.accept).not.toHaveBeenCalled();
    });
    it('quotes cards and tickets together and spells out both results', async () => {
      await open(20, { initialPullId: 'p1' });
      await click('Add');
      await type('5');
      mocks.quote.mockResolvedValue({ ok: true, round: withCard });
      await click('Review flip');
      expect(mocks.quote).toHaveBeenCalledExactlyOnceWith(['p1'], 'head', 5);
      const dialog = document.querySelector('[role=dialog]')!.textContent;
      expect(dialog).toContain('Put this card and 5 tickets on the line?');
      expect(dialog).toContain('withdrawable Credit');
      expect(dialog).toContain('5 tickets more');
      expect(dialog).toContain('permanently forfeited');
      expect(dialog).toContain('All 5 tickets you flipped are gone');
      expect(button('Confirm card + 5 tickets · Tail')).toBeTruthy();
      expect(mocks.accept).not.toHaveBeenCalled();
    });
    it('a win with cards shows the Credit and the tickets, and Flip again brings back both', async () => {
      await open(20, { initialPullId: 'p1' });
      await toss(withCard, 'won', 25);
      expect(host.querySelector('[role=status] h2')?.textContent).toContain(
        '+RM 100.00',
      );
      const result = visible(host.querySelector('[role=status]'));
      expect(result).toContain('+× 5');
      expect(result).not.toContain('5 tickets');
      await click('Flip again');
      expect(mocks.quote).toHaveBeenCalledTimes(1);
      expect(amount().value).toBe('5');
      expect(document.activeElement).toBe(button('Review flip'));
      await click('Review flip');
      expect(mocks.quote).toHaveBeenLastCalledWith(['p1'], 'tail', 5);
    });
    it('a loss with cards forfeits them, takes the tickets and offers no second go', async () => {
      await open(20, { initialPullId: 'p1' });
      await toss(withCard, 'lost', 15);
      expect(host.querySelector('[role=status] h2')?.textContent).toBe(
        'Card forfeited',
      );
      expect(visible(host.querySelector('[role=status]'))).toContain(
        '× 5 lost',
      );
      expect(host.textContent).toContain('Tickets you did not flip are safe');
      expect(offered('Flip again')).toBe(false);
      await click('Choose cards');
      // Starting over starts at no tickets again.
      expect(amount()).toBeNull();
    });
    it('remembers the amount staked, not one a loss has since cut', async () => {
      await open(8);
      await toss(ticketsOnly, 'lost', 3);
      await click('Choose amount');
      expect(amount().value).toBe('3');
      const three = { ...ticketsOnly, tickets: 3 };
      mocks.quote.mockResolvedValue({ ok: true, round: three });
      mocks.accept.mockResolvedValue({
        ok: true,
        round: settledRound(three, 'won'),
      });
      mocks.tickets.mockResolvedValue(6);
      await click('Review tickets');
      await click('Confirm 3 tickets · Tail');
      await click('Flip coin');
      await act(async () => {
        mocks.scene.mock.lastCall?.[0].onComplete();
      });
      await click('Choose amount');
      expect(amount().value).toBe('3');
    });
    it('a ticket win offers the same amount again, never the doubled balance', async () => {
      await open(20);
      await toss(ticketsOnly, 'won', 25);
      const heading = host.querySelector('[role=status] h2');
      expect(visible(heading)).toBe('+× 5');
      expect(heading?.querySelector('.sr-only')?.textContent).toBe('5 tickets');
      expect(host.textContent).not.toContain('RM 0.00');
      expect(mocks.refresh).toHaveBeenCalled();
      await click('Flip again');
      expect(mocks.quote).toHaveBeenCalledTimes(1);
      expect(amount().value).toBe('5');
      expect(document.activeElement).toBe(button('Review tickets'));
      expect(
        document.querySelector<HTMLInputElement>('input[value="tail"]')!
          .checked,
      ).toBe(true);
    });
    it('a ticket loss takes them all and lets the player pick again', async () => {
      await open(20);
      await toss(ticketsOnly, 'lost', 15);
      expect(visible(host.querySelector('[role=status] h2'))).toBe('× 5 lost');
      expect(host.textContent).toContain('All 5 tickets you flipped are gone');
      expect(offered('Flip again')).toBe(false);
      await click('Choose amount');
      expect(amount().value).toBe('5');
    });
    it('after losing every ticket it falls back to cards', async () => {
      await open(5);
      await toss(ticketsOnly, 'lost', 0);
      await click('Choose cards');
      expect(amount()).toBeNull();
    });
    it('an amount picked before a loss cannot exceed what is left', async () => {
      await open(20);
      await toss(ticketsOnly, 'lost', 3);
      await click('Choose amount');
      expect(amount().value).toBe('3');
    });
    it('offers no Flip again on an old win the balance can no longer cover', async () => {
      mocks.read.mockResolvedValue({
        ok: true,
        round: settledRound(withCard, 'won'),
      });
      mocks.tickets.mockResolvedValue(4);
      window.history.replaceState(
        {},
        '',
        `/vault/coin-flip?round=${withCard.id}`,
      );
      await open(4);
      expect(offered('Choose cards')).toBe(true);
      expect(offered('Flip again')).toBe(false);
    });
    it('reopening a tickets receipt from history shows tickets, not an empty card list', async () => {
      mocks.read.mockResolvedValue({
        ok: true,
        round: settledRound(ticketsOnly, 'won'),
      });
      mocks.tickets.mockResolvedValue(25);
      window.history.replaceState(
        {},
        '',
        `/vault/coin-flip?round=${ticketsOnly.id}`,
      );
      await open(25);
      expect(visible(host.querySelector('[role=status] h2'))).toBe('+× 5');
      expect(host.textContent).not.toContain('Choose from Vault');
    });
  });
  describe('code review fixes', () => {
    const won: CoinFlipRound = {
      ...round,
      status: 'won',
      landed_side: 'head',
      win_amount: 100,
      settled_at: round.expires_at,
    };
    const reopen = () =>
      act(async () => {
        window.history.replaceState({}, '', `/vault/coin-flip?round=${won.id}`);
        root.render(
          createElement(CoinFlipClient, {
            customerId: 'c1',
            initialVault: vault,
            initialSettings: settings,
          }),
        );
      });
    it('keeps the vault and settings when a refresh after the result fails', async () => {
      mocks.read.mockResolvedValue({ ok: true, round: won });
      mocks.vault.mockResolvedValue({ ok: false, error: 'read failed' });
      mocks.settings.mockResolvedValue({
        ok: false,
        error: 'read failed',
        uncertain: true,
      });
      await reopen();
      expect(button('Flip again')).toBeTruthy();
      expect(host.textContent).not.toContain('read failed');
    });
    it('opening a receipt does not flash the unresolved-flip panel', async () => {
      mocks.read.mockImplementation(() => new Promise(() => {}));
      await reopen();
      expect(host.textContent).toContain('Checking previous flips');
      expect(host.textContent).not.toContain('Resolve your previous flip');
    });
    it('still offers recovery when the read itself fails', async () => {
      mocks.read.mockResolvedValue({
        ok: false,
        error: 'Could not confirm',
        uncertain: true,
      });
      await reopen();
      expect(host.textContent).toContain('Resolve your previous flip');
    });
    it('keeps recovery until the coin has landed', async () => {
      mocks.accept.mockResolvedValue({ ok: true, round: won });
      await render();
      await click('Review cards');
      await click('Confirm card · Head');
      await click('Flip coin');
      expect(host.textContent).toContain('Coin in flight');
      expect(localStorage.getItem('polycards:coin-flip:c1')).toBe(round.id);
      await act(async () => {
        mocks.scene.mock.lastCall?.[0].onComplete();
      });
      expect(localStorage.getItem('polycards:coin-flip:c1')).toBeNull();
    });
    it('Choose cards drops the spent round from the URL', async () => {
      window.history.replaceState({}, '', `/vault/coin-flip?round=${won.id}`);
      mocks.read.mockResolvedValue({ ok: true, round: won });
      await reopen();
      await click('Choose cards');
      expect(window.location.search).toBe('');
    });
    it('a refused quote refreshes the vault, so a stale card can drop out', async () => {
      await render();
      mocks.vault.mockClear();
      mocks.quote.mockResolvedValue({
        ok: false,
        error: 'gone',
        uncertain: false,
      });
      await click('Review cards');
      expect(mocks.vault).toHaveBeenCalledTimes(1);
      expect(host.textContent).toContain('gone');
    });
    it('a fast device clock does not expire a live quote', async () => {
      await render();
      // The server's 60 seconds end before this device thinks "now" is.
      mocks.quote.mockResolvedValue({
        ok: true,
        round: {
          ...round,
          expires_at: new Date(Date.now() - 5 * 60_000).toISOString(),
        },
      });
      await click('Review cards');
      expect(button('Confirm card · Head').disabled).toBe(false);
    });
    it('can empty a card selection to flip tickets alone', async () => {
      await act(async () => {
        root.render(
          createElement(CoinFlipClient, {
            customerId: 'c1',
            initialVault: vault,
            initialSettings: settings,
            initialPullId: 'p1',
            initialTickets: 5,
            initialStake: 'tickets',
          }),
        );
      });
      await click('Edit selection');
      await act(async () =>
        document
          .querySelector<HTMLButtonElement>('button[aria-pressed="true"]')!
          .click(),
      );
      await click('Clear cards');
      expect(mocks.quote).not.toHaveBeenCalled();
      expect(button('Review tickets').disabled).toBe(false);
    });
    it('moves focus on when Add or the last − remove the pressed button', async () => {
      await act(async () => {
        root.render(
          createElement(CoinFlipClient, {
            customerId: 'c1',
            initialVault: vault,
            initialSettings: settings,
            initialTickets: 5,
          }),
        );
      });
      await click('Add');
      expect(document.activeElement?.getAttribute('aria-label')).toBe(
        'One ticket more',
      );
      await act(async () => {
        document
          .querySelector<HTMLButtonElement>(
            'button[aria-label="One ticket fewer"]',
          )!
          .click();
      });
      expect(document.activeElement).toBe(button('Add'));
    });
  });
  describe('the address and the stake after a flip', () => {
    const settled = (status: 'won' | 'lost', id = round.id): CoinFlipRound => ({
      ...round,
      id,
      status,
      settled_at: '2026-10-30T07:00:00.000Z',
      landed_side: status === 'won' ? 'head' : 'tail',
      win_amount: status === 'won' ? 100 : 0,
    });
    const heading = () => host.querySelector('[role=status] h2')?.textContent;

    it('opens the flip the address names, because Back restores old props', async () => {
      window.history.replaceState({}, '', '/vault/coin-flip?round=cfr_lost');
      mocks.read.mockResolvedValue({
        ok: true,
        round: settled('lost', 'cfr_lost'),
      });
      await render();
      expect(mocks.read).toHaveBeenCalledExactlyOnceWith('cfr_lost');
      expect(heading()).toBe('Card forfeited');
    });
    it('re-reads the Vault and tickets on arriving, since those props can be old too', async () => {
      mocks.vault.mockClear();
      mocks.tickets.mockClear();
      await act(async () => {
        root.render(
          createElement(CoinFlipClient, {
            customerId: 'c1',
            initialVault: vault,
            initialSettings: settings,
          }),
        );
      });
      expect(mocks.vault).toHaveBeenCalledTimes(1);
      expect(mocks.tickets).toHaveBeenCalledTimes(1);
    });
    it('a history row opens in place, and again after leaving it', async () => {
      const scroll = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
      mocks.read.mockResolvedValue({
        ok: true,
        round: settled('lost', 'cfr_row'),
      });
      await render();
      const open = () =>
        act(async () => {
          mocks.history.mock.lastCall?.[0].onOpen('cfr_row');
        });
      await open();
      expect(window.location.search).toBe('?round=cfr_row');
      expect(heading()).toBe('Card forfeited');
      await click('Choose cards');
      expect(window.location.search).toBe('');
      await open();
      expect(mocks.read).toHaveBeenCalledTimes(2);
      expect(heading()).toBe('Card forfeited');
      scroll.mockRestore();
    });
    it('a pending flip outranks the address, and the address follows it', async () => {
      window.history.replaceState({}, '', '/vault/coin-flip?round=cfr_other');
      localStorage.setItem('polycards:coin-flip:c1', 'cfr_pending');
      mocks.read.mockResolvedValue({
        ok: true,
        round: settled('won', 'cfr_pending'),
      });
      await render();
      expect(mocks.read).toHaveBeenCalledExactlyOnceWith('cfr_pending');
      expect(window.location.search).toBe('?round=cfr_pending');
    });
    it('a lost card is not offered again, even when the refresh fails', async () => {
      await render();
      mocks.vault.mockResolvedValue({ ok: false, error: 'read failed' });
      mocks.quote.mockResolvedValue({ ok: true, round });
      mocks.accept.mockResolvedValue({ ok: true, round: settled('lost') });
      await click('Review cards');
      await click('Confirm card · Head');
      await click('Flip coin');
      await act(async () => {
        mocks.scene.mock.lastCall?.[0].onComplete();
      });
      expect(heading()).toBe('Card forfeited');
      await click('Choose cards');
      expect(document.body.textContent).not.toContain('Pikachu');
    });
  });
  describe('Flip again', () => {
    const extra = {
      ...vault.items[0]!,
      pullId: 'p2',
      card: { ...vault.items[0]!.card, name: 'Eevee', priceMyr: 75 },
    };
    const twoCardVault = { ...vault, items: [...vault.items, extra] };
    const bundle: CoinFlipRound = {
      ...round,
      chosen_side: 'tail',
      stake_amount: 175,
      cards: [
        ...round.cards,
        { ...round.card!, pull_id: 'p2', name: 'Eevee', stake_amount: 75 },
      ],
    };
    const settled = (status: 'won' | 'lost'): CoinFlipRound => ({
      ...bundle,
      status,
      landed_side: status === 'won' ? 'tail' : 'head',
      win_amount: status === 'won' ? 175 : 0,
    });
    function reopen(status: 'won' | 'lost', vaultNow: VaultResult) {
      mocks.read.mockResolvedValue({ ok: true, round: settled(status) });
      mocks.vault.mockResolvedValue(vaultNow);
      window.history.replaceState(
        {},
        '',
        `/vault/coin-flip?round=${bundle.id}`,
      );
      return act(async () => {
        root.render(
          createElement(CoinFlipClient, {
            customerId: 'c1',
            initialVault: vaultNow,
            initialSettings: settings,
          }),
        );
      });
    }
    const named = (name: string) =>
      [...document.querySelectorAll('button')].some(
        (b) => b.textContent === name,
      );

    it('puts the same cards and call back up, then asks for a fresh quote and Confirm', async () => {
      window.history.replaceState(
        {},
        '',
        `/vault/coin-flip?round=${bundle.id}`,
      );
      await reopen('won', twoCardVault);
      expect(mocks.quote).not.toHaveBeenCalled();
      await click('Flip again');
      // Nothing is staked by the tap itself.
      expect(mocks.quote).not.toHaveBeenCalled();
      expect(mocks.accept).not.toHaveBeenCalled();
      expect(window.location.search).toBe('');
      expect(document.activeElement).toBe(button('Review cards'));
      expect(
        document.querySelector<HTMLInputElement>('input[value="tail"]')!
          .checked,
      ).toBe(true);
      mocks.quote.mockResolvedValue({ ok: true, round: bundle });
      await click('Review cards');
      expect(mocks.quote).toHaveBeenCalledExactlyOnceWith(
        ['p1', 'p2'],
        'tail',
        0,
      );
      expect(document.querySelector('[role=dialog]')?.textContent).toContain(
        'Every selected card is permanently forfeited',
      );
      expect(mocks.accept).not.toHaveBeenCalled();
    });
    it('is not offered after a loss', async () => {
      await reopen('lost', twoCardVault);
      expect(named('Choose cards')).toBe(true);
      expect(named('Flip again')).toBe(false);
    });
    it('is not offered when a card from that flip has left the Vault', async () => {
      await reopen('won', vault);
      expect(named('Choose cards')).toBe(true);
      expect(named('Flip again')).toBe(false);
    });
    it('is not offered while the account cannot flip', async () => {
      mocks.settings.mockResolvedValue({
        ok: true,
        settings: { ...settings.settings, eligible: false, reason: 'Paused.' },
      });
      await reopen('won', twoCardVault);
      expect(named('Flip again')).toBe(false);
    });
  });
  it('leaving during a settled toss still refreshes the wallet', async () => {
    mocks.accept.mockResolvedValue({
      ok: true,
      round: { ...round, status: 'won', landed_side: 'head', win_amount: 100 },
    });
    await render();
    await click('Review cards');
    await click('Confirm card · Head');
    await click('Flip coin');
    expect(mocks.refresh).not.toHaveBeenCalled();
    await act(async () => root.render(null));
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });
  it('keeps recovery and refreshes the wallet when acceptance arrives after leaving', async () => {
    let resolve!: (value: unknown) => void;
    mocks.accept.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await render();
    await click('Review cards');
    await click('Confirm card · Head');
    await click('Flip coin');
    await act(async () => root.render(null));
    await act(async () =>
      resolve({
        ok: true,
        round: {
          ...round,
          status: 'won',
          landed_side: 'head',
          win_amount: 100,
        },
      }),
    );
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('polycards:coin-flip:c1')).toBe(round.id);
  });
  it('lost response recovers original win without resubmitting', async () => {
    mocks.accept.mockRejectedValue(new Error('timeout'));
    mocks.read.mockResolvedValue({
      ok: true,
      round: { ...round, status: 'won', landed_side: 'head', win_amount: 100 },
    });
    await render();
    await click('Review cards');
    await click('Confirm card · Head');
    await click('Flip coin');
    expect(host.textContent).toContain('result is unknown');
    await click('Check result');
    expect(host.textContent).toContain('+RM 100.00');
    expect(mocks.accept).toHaveBeenCalledTimes(1);
    // A recovered receipt is read, not celebrated.
    expect(mocks.sfx).not.toHaveBeenCalled();
    expect(mocks.scene.mock.lastCall?.[0]).toMatchObject({ revealed: false });
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
    expect(button('Review cards')).toBeTruthy();
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
    expect(button('Review cards').disabled).toBe(false);
    expect(mocks.accept).not.toHaveBeenCalled();
  });
});

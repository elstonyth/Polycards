// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// The two steps that unlock withdrawals: which one is done, which pill is the
// one white action, and the copy step 2 carries.

vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
  }) => createElement('a', { href, ...rest }, children),
}));

const openTopUp = vi.fn();
vi.mock('@/components/app-shell/TopUpProvider', () => ({
  useTopUp: () => ({ openTopUp }),
}));

const { WithdrawSteps, MoneyRows, WithdrawRules, WITHDRAW_RULES } =
  await import('../WithdrawSteps');
const { walletSplit } = await import('@/lib/wallet-split');

let container: HTMLDivElement;
let root: Root;

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function render(el: React.ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(el));
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const PRIMARY = 'bg-neutral-50';
const NB = ' ';

function steps() {
  return [...container.querySelectorAll('ol > li')].map((li) => li);
}

describe('WithdrawSteps', () => {
  it('never topped up: step 1 is the white Top Up pill, Open packs waits as secondary', () => {
    render(
      createElement(WithdrawSteps, {
        hasTopup: false,
        depositMinRm: 50,
        available: 30,
        bonus: 0,
        remaining: 0,
      }),
    );
    const [one, two] = steps();
    expect(one?.textContent).toContain('Top up once');
    expect(one?.textContent).toContain('From RM 50');
    const topUp = one?.querySelector('button');
    expect(topUp?.textContent).toBe('Top Up');
    expect(topUp?.className).toContain(PRIMARY);
    act(() => {
      topUp!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(openTopUp).toHaveBeenCalledOnce();
    expect(two?.textContent).toContain('Use your top-up on packs');
    const open = two?.querySelector('a[href="/slots"]');
    expect(open?.textContent).toBe('Open packs');
    expect(open?.className).not.toContain(PRIMARY);
    expect(container.textContent).toContain(
      'Then your balance, except bonus credit, can go to your bank.',
    );
  });

  it('topped up: step 1 is done and Open packs becomes the white pill', () => {
    render(
      createElement(WithdrawSteps, {
        hasTopup: true,
        depositMinRm: 50,
        available: 125,
        bonus: 15,
        remaining: 80,
        id: 'withdraw-hold-reason',
      }),
    );
    const [one, two] = steps();
    expect(one?.textContent).toBe('Top up onceDone');
    expect(one?.querySelector('button')).toBeNull();
    expect(two?.textContent).toContain(`Use RM${NB}95.00 more on packs`);
    expect(two?.textContent).toContain(
      `This includes your RM${NB}15.00 bonus credit, which packs use first.`,
    );
    expect(two?.querySelector('a[href="/slots"]')?.className).toContain(
      PRIMARY,
    );
    // Exactly one white action in the zone.
    expect(container.querySelectorAll(`.${PRIMARY}`)).toHaveLength(1);
    expect(container.firstElementChild?.id).toBe('withdraw-hold-reason');
  });

  it('never topped up with money for packs: names the top-up plus that money', () => {
    render(
      createElement(WithdrawSteps, {
        hasTopup: false,
        depositMinRm: 30,
        available: 80.97,
        bonus: 0,
        remaining: 20.5,
      }),
    );
    const two = steps()[1];
    expect(two?.textContent).toContain('Use your top-up on packs');
    expect(two?.textContent).toContain(
      `Plus RM${NB}20.50 you already have for packs.`,
    );
  });
});

describe('MoneyRows', () => {
  it('adds up: Balance = Withdrawable + Withdrawable later + For packs', () => {
    const split = walletSplit({
      available: 350,
      withdrawable: 0,
      bonus: 0,
      remaining: 50,
    });
    render(createElement(MoneyRows, { balance: 350, withdrawable: 0, split }));
    const rows = [...container.querySelectorAll('dl div')]
      .filter((d) => d.querySelector(':scope > dt'))
      .map((d) => [
        d.querySelector('dt')?.textContent,
        d.querySelector('dd')?.textContent,
      ]);
    expect(rows).toEqual([
      ['Balance', 'RM 350.00'],
      ['Withdrawable', 'RM 0.00'],
      ['Withdrawable later', 'RM 300.00'],
      ['For packs', 'RM 50.00'],
      ['Bonus credit · used first', 'RM 0.00'],
      ['Still to use on packs', 'RM 50.00'],
    ]);
  });

  it('hides Withdrawable later when nothing waits on the gate', () => {
    const split = walletSplit({
      available: 300,
      withdrawable: 300,
      bonus: 0,
      remaining: 0,
    });
    render(createElement(MoneyRows, { withdrawable: 300, split }));
    expect(container.textContent).not.toContain('Withdrawable later');
    expect(container.textContent).not.toContain('Balance');
  });
});

describe('WithdrawRules', () => {
  it('says the three rules once, in order', () => {
    render(createElement(WithdrawRules));
    expect(
      [...container.querySelectorAll('li p')].map((p) => p.textContent),
    ).toEqual([...WITHDRAW_RULES]);
  });
});

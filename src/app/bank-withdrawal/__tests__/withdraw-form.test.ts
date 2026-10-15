// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// The withdrawal form debits real balance on submit, so these pin the money
// behaviors: the band guard, the balance guard, the no-overpromise copy
// ("on its way", never "paid"), and that nothing is submitted while invalid.
//
// It also pins the destination binding: the form submits an ACCOUNT ID, and an
// account still inside its cooling-off window is visible and disabled rather
// than hidden. The form has no bank fields at all any more — a destination is
// added on /bank and cannot be paid to in the same session.

const startWithdrawal = vi.fn();
const fetchSavedBankAccounts = vi.fn();
const getPaymentLimits = vi.fn();
vi.mock('@/lib/actions/vault', () => ({
  startWithdrawal: (...args: unknown[]) => startWithdrawal(...args),
  fetchSavedBankAccounts: () => fetchSavedBankAccounts(),
  // The band is the active gateway's; the tests below pin RM 50 – 50,000.
  getPaymentLimits: () => getPaymentLimits(),
}));

// The form repaints the header balance on success, so it now reads useTopUp —
// which throws outside its provider. Stubbing the hook keeps these cases about
// the money guards instead of dragging the whole app-shell provider stack in.
const applyBalance = vi.fn();
const openTopUp = vi.fn();
vi.mock('@/components/app-shell/TopUpProvider', () => ({
  useTopUp: () => ({ applyBalance, openTopUp }),
}));

import WithdrawForm, {
  minimumGap,
  nextAmountText,
  withdrawRemedy,
} from '../WithdrawForm';

let container: HTMLDivElement;
let root: Root;

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const hoursFromNow = (h: number) =>
  new Date(Date.now() + h * 60 * 60 * 1000).toISOString();

/** Saved two days ago, so the server has marked it payable. */
const READY_ACCOUNT = {
  id: 'acc_ready',
  bankCode: 'MBB',
  bankName: 'Maybank',
  accountNumber: '1234567890',
  accountHolderName: 'AHMAD BIN ALI',
  usableFrom: hoursFromNow(-24),
};

/** Added a moment ago — still cooling off. */
const COOLING_ACCOUNT = {
  id: 'acc_cooling',
  bankCode: 'CIMB',
  bankName: 'CIMB Bank',
  accountNumber: '5555555555',
  accountHolderName: 'AHMAD BIN ALI',
  usableFrom: hoursFromNow(20),
};

/** Saved before the cooling-off rule existed: waiting never arms it. */
const NEEDS_RESAVE_ACCOUNT = {
  id: 'acc_legacy',
  bankCode: 'PBB',
  bankName: 'Public Bank',
  accountNumber: '7777777777',
  accountHolderName: 'AHMAD BIN ALI',
  usableFrom: null,
};

async function render(
  accounts: unknown[] = [READY_ACCOUNT],
  withdrawable: number | null = 100,
  hold: {
    available?: number;
    frozen?: boolean;
    noTopup?: boolean;
    bonus?: number;
    remaining?: number;
  } = {},
) {
  fetchSavedBankAccounts.mockResolvedValue({ ok: true, accounts });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(createElement(WithdrawForm, { withdrawable, ...hold }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  getPaymentLimits.mockResolvedValue({
    gateway: 'tgpay',
    deposit: { minRm: 30, maxRm: 10000 },
    withdrawal: { minRm: 50, maxRm: 50000 },
    depositsEnabled: true,
    withdrawalsEnabled: true,
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function setValue(selector: string, value: string) {
  const el = container.querySelector<HTMLInputElement | HTMLSelectElement>(
    selector,
  );
  if (!el) throw new Error(`not found: ${selector}`);
  const proto =
    el instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;
  const set = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
  act(() => {
    set.call(el, value);
    el.dispatchEvent(
      new Event(el instanceof HTMLSelectElement ? 'change' : 'input', {
        bubbles: true,
      }),
    );
  });
}

function fillValidForm(amount = '50') {
  setValue('select[aria-label="Saved bank account"]', READY_ACCOUNT.id);
  setValue('input[aria-label="Withdrawal amount in RM"]', amount);
}

function amountInput(): HTMLInputElement {
  return container.querySelector<HTMLInputElement>(
    'input[aria-label="Withdrawal amount in RM"]',
  )!;
}

function submitButton(): HTMLButtonElement {
  const btn = [...container.querySelectorAll('button')].find((b) =>
    /^Withdraw/.test(b.textContent ?? ''),
  );
  if (!btn) throw new Error('submit button not found');
  return btn;
}

async function submit() {
  await act(async () => {
    submitButton().dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('WithdrawForm', () => {
  it('offers the saved accounts and no bank fields at all', async () => {
    await render([READY_ACCOUNT, COOLING_ACCOUNT]);
    expect(fetchSavedBankAccounts).toHaveBeenCalledOnce();
    const options = [...container.querySelectorAll('option')].map(
      (o) => o.textContent ?? '',
    );
    expect(options.some((t) => t.includes('Maybank'))).toBe(true);
    expect(options.some((t) => t.includes('CIMB Bank'))).toBe(true);
    // The old free-text destination inputs are gone — if they came back, a
    // stolen token could name its own payee again.
    expect(
      container.querySelector('input[aria-label="Account number"]'),
    ).toBeNull();
    expect(
      container.querySelector('input[aria-label="Account holder name"]'),
    ).toBeNull();
  });

  it('renders a cooling-off account visible and DISABLED, with its timing', async () => {
    await render([READY_ACCOUNT, COOLING_ACCOUNT]);
    const cooling = [...container.querySelectorAll('option')].find(
      (o) => (o as HTMLOptionElement).value === COOLING_ACCOUNT.id,
    ) as HTMLOptionElement;
    // Visible, not hidden: a saved account missing from the picker reads as a bug.
    expect(cooling).toBeTruthy();
    expect(cooling.disabled).toBe(true);
    expect(cooling.textContent).toMatch(/available in \d+[mhd]/);

    const ready = [...container.querySelectorAll('option')].find(
      (o) => (o as HTMLOptionElement).value === READY_ACCOUNT.id,
    ) as HTMLOptionElement;
    expect(ready.disabled).toBe(false);
  });

  it('an account with no usableFrom is disabled and says to save it again', async () => {
    await render([NEEDS_RESAVE_ACCOUNT]);
    const legacy = [...container.querySelectorAll('option')].find(
      (o) => (o as HTMLOptionElement).value === NEEDS_RESAVE_ACCOUNT.id,
    ) as HTMLOptionElement;
    expect(legacy.disabled).toBe(true);
    expect(legacy.textContent).toContain('save it again');
    expect(submitButton().disabled).toBe(true);
  });

  it('cannot submit while only a cooling-off account exists', async () => {
    await render([COOLING_ACCOUNT]);
    setValue('input[aria-label="Withdrawal amount in RM"]', '50');
    expect(submitButton().disabled).toBe(true);
    await submit();
    expect(startWithdrawal).not.toHaveBeenCalled();
  });

  it('points a customer with no saved accounts at /bank', async () => {
    await render([]);
    expect(container.textContent).toContain('No saved bank accounts yet');
    const link = container.querySelector('a[href="/bank"]');
    expect(link?.textContent).toContain('Add a bank account');
  });

  it('keeps the button disabled until an account and amount are chosen', async () => {
    await render();
    setValue('select[aria-label="Saved bank account"]', '');
    expect(submitButton().disabled).toBe(true);
    fillValidForm();
    expect(submitButton().disabled).toBe(false);
  });

  it('disables the amount field and submit when withdrawals are paused, with a guidance line', async () => {
    getPaymentLimits.mockResolvedValue({
      gateway: 'tgpay',
      deposit: { minRm: 30, maxRm: 10000 },
      withdrawal: { minRm: 50, maxRm: 50000 },
      depositsEnabled: true,
      withdrawalsEnabled: false,
    });
    await render();
    fillValidForm();
    expect(
      container.querySelector<HTMLInputElement>(
        'input[aria-label="Withdrawal amount in RM"]',
      )?.disabled,
    ).toBe(true);
    expect(submitButton().disabled).toBe(true);
    expect(container.textContent).toContain('Withdrawals are paused.');
    await submit();
    expect(startWithdrawal).not.toHaveBeenCalled();
  });

  it('says when to come back during a timed pause', async () => {
    getPaymentLimits.mockResolvedValue({
      gateway: 'tgpay',
      deposit: { minRm: 30, maxRm: 10000 },
      withdrawal: { minRm: 50, maxRm: 50000 },
      depositsEnabled: true,
      withdrawalsEnabled: false,
      withdrawalsPausedUntil: '2026-10-07T22:00:00.000Z',
    });
    await render();
    expect(container.textContent).toContain(
      'Withdrawals are paused until 6:00 AM. Your balance is safe — please try again after 6:00 AM.',
    );
    expect(submitButton().disabled).toBe(true);
  });

  it.each(['49', '50001'])(
    'rejects RM %s in the form without touching the backend',
    async (amount) => {
      await render([READY_ACCOUNT], 100000);
      fillValidForm(amount);
      await submit();
      expect(container.querySelector('[role="alert"]')?.textContent).toBe(
        'Withdrawals must be between RM 50 and RM 50,000.',
      );
      expect(startWithdrawal).not.toHaveBeenCalled();
    },
  );

  it('reads the band from the active gateway: RM 40,000 is refused under TGPay (max 30,000)', async () => {
    getPaymentLimits.mockResolvedValue({
      gateway: 'tgpay',
      deposit: { minRm: 50, maxRm: 10000 },
      withdrawal: { minRm: 50, maxRm: 30000 },
      depositsEnabled: true,
      withdrawalsEnabled: true,
    });
    await render([READY_ACCOUNT], 100000);
    fillValidForm('40000');
    await submit();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'Withdrawals must be between RM 50 and RM 30,000.',
    );
    expect(startWithdrawal).not.toHaveBeenCalled();
  });

  // The form enters RM. A Singapore account is paid through A3Pay in S$, so
  // its floor is what pays S$30 at today's rate, not the RM gateway's RM 50.
  it("judges a Singapore account by the S$ rail's own RM band", async () => {
    const SG_ACCOUNT = {
      ...READY_ACCOUNT,
      id: 'acc_sg',
      bankCode: 'DBSSSGSG',
      bankName: 'DBS Bank',
      currency: 'SGD',
    };
    getPaymentLimits.mockResolvedValue({
      gateway: 'tgpay',
      deposit: { minRm: 50, maxRm: 10000 },
      withdrawal: { minRm: 50, maxRm: 30000 },
      depositsEnabled: true,
      withdrawalsEnabled: true,
      regional: [
        {
          gateway: 'a3pay',
          currency: 'SGD',
          depositsEnabled: true,
          withdrawalsEnabled: true,
          deposit: { min: 30, max: 3150 },
          withdrawal: { min: 30, max: 10000 },
          withdrawalRm: { minRm: 96.05, maxRm: 30000 },
          rate: { deposit: 3.169804, payout: 3.201662 },
        },
      ],
    });
    await render([SG_ACCOUNT], 1000);
    setValue('select[aria-label="Saved bank account"]', SG_ACCOUNT.id);
    setValue('input[aria-label="Withdrawal amount in RM"]', '80');
    await submit();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'Singapore payouts must be between RM 96.05 and RM 30,000 today.',
    );
    expect(startWithdrawal).not.toHaveBeenCalled();
  });

  it('caps a typed or pasted amount at the withdrawable figure', async () => {
    await render();
    fillValidForm('200');
    expect(amountInput().value).toBe('100.00');
    startWithdrawal.mockResolvedValue({ ok: false, error: 'x' });
    await submit();
    expect(startWithdrawal).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 100 }),
    );
  });

  it('refuses keystrokes that are not an amount, keeping the last good value', async () => {
    await render();
    for (const [good, bad] of [
      ['60', '60abc'],
      ['1.23', '1.234'],
      ['5.5', '5.5.'],
      ['70', '-70'],
    ] as const) {
      setValue('input[aria-label="Withdrawal amount in RM"]', good);
      setValue('input[aria-label="Withdrawal amount in RM"]', bad);
      expect(amountInput().value).toBe(good);
    }
  });

  it('reads "1,000" as RM 1,000, not RM 1', async () => {
    await render([READY_ACCOUNT], 5000);
    fillValidForm('1,000');
    expect(amountInput().value).toBe('1,000');
    startWithdrawal.mockResolvedValue({ ok: false, error: 'x' });
    await submit();
    expect(startWithdrawal).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 1000 }),
    );
  });

  it('submits an ACCOUNT ID and shows the async success state — "on its way", never "paid"', async () => {
    await render();
    startWithdrawal.mockResolvedValue({
      ok: true,
      amount: 50,
      balance: 50,
      reference: 'W2026072200000001',
    });
    fillValidForm();
    await submit();

    // The destination is an id and nothing else: the server resolves the bank
    // details from the customer's own saved list. A per-attempt idempotency
    // key rides along too (see the attemptKey doc comment) — its exact value
    // is random, so only its shape is pinned here.
    expect(startWithdrawal).toHaveBeenCalledExactlyOnceWith({
      amount: 50,
      accountId: READY_ACCOUNT.id,
      idempotencyKey: expect.any(String),
    });
    // The payout debits the balance server-side; the form must repaint it, or
    // the header chip stays stale. (It also used to light the Me-tab money dot
    // — suspended 2026-08-11, see components/account/credit-dot.tsx.)
    expect(applyBalance).toHaveBeenCalledWith(50);
    const text = container.textContent ?? '';
    expect(text).toContain('RM 50.00 ON ITS WAY');
    // The transfer is asynchronous — the form must not claim it completed.
    expect(text).not.toMatch(/has been sent|paid|complete/i);
    // And it must say what happens if the bank bounces it.
    expect(text).toContain('returns to your balance');
    expect(text).toContain('W2026072200000001');
    expect(text).toContain('RM 50.00');
    // An RM payout has no second currency to name.
    expect(text).not.toContain('to your bank');
  });

  // A Singapore payout leaves the RM balance but lands in S$: the success
  // screen names what the bank receives, as the form did before the tap.
  it('names the S$ the bank receives on a Singapore payout', async () => {
    await render([READY_ACCOUNT], 1000);
    startWithdrawal.mockResolvedValue({
      ok: true,
      amount: 160,
      balance: 33387.4,
      reference: 'W2026101400000025',
      status: 'pending',
      payout: { currency: 'SGD', amount: 50.14 },
    });
    fillValidForm('160');
    await submit();
    const text = container.textContent ?? '';
    expect(text).toContain('RM 160.00 ON ITS WAY');
    expect(text).toContain('S$50.14 to your bank');
  });

  it('shows a held withdrawal as awaiting approval — never "paid", never spendable', async () => {
    await render();
    startWithdrawal.mockResolvedValue({
      ok: true,
      amount: 80,
      balance: 20,
      reference: 'wd_merchant_ref_123',
      status: 'held',
    });
    fillValidForm('80');
    await submit();

    const text = container.textContent ?? '';
    expect(text).toContain('RM 80.00 AWAITING APPROVAL');
    // A held withdrawal was never submitted to the gateway — it must never
    // read as a completed payout. "Under review" now means a frozen account.
    expect(text).not.toMatch(/paid|complete|has been sent|ON ITS WAY/i);
    expect(text).not.toMatch(/under review/i);
    // It must say plainly that the debit already happened and what happens
    // if a human refuses it — without naming the threshold figure, which
    // the backend reads from an env var.
    expect(text).toContain('already left your balance');
    expect(text).toContain('returns automatically');
    expect(text).not.toMatch(/RM ?1,?000/);
    expect(text).toContain('wd_merchant_ref_123');
    // The POST-debit balance — showing it is how the copy avoids implying
    // the withdrawn amount is still spendable.
    expect(text).toContain('RM 20.00');
  });

  it('shows the server error and stays on the form when the backend refuses', async () => {
    await render();
    startWithdrawal.mockResolvedValue({
      ok: false,
      error: 'Withdrawals are not open yet.',
    });
    fillValidForm();
    await submit();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'Withdrawals are not open yet.',
    );
    expect(container.textContent).not.toContain('ON ITS WAY');
  });

  // The dangerous direction: if a retry ever minted a NEW key, a debited-but-
  // response-lost first attempt plus a retry would be a second debit and a
  // second real bank transfer. This pins the key staying armed across a
  // failed attempt, exactly like TopUpSheet's attemptKey.
  it('reuses the SAME idempotency key across a failed retry of the same attempt', async () => {
    await render();
    // Set for BOTH calls (not Once): the key-reuse assertion below must hold
    // regardless of what any earlier test left as the mock's implementation.
    startWithdrawal.mockResolvedValue({
      ok: false,
      error: 'Something went wrong. Please try again.',
    });
    fillValidForm();
    await submit();
    await submit();

    expect(startWithdrawal).toHaveBeenCalledTimes(2);
    const [firstCall] = startWithdrawal.mock.calls[0]! as [
      { idempotencyKey: string },
    ];
    const [secondCall] = startWithdrawal.mock.calls[1]! as [
      { idempotencyKey: string },
    ];
    expect(secondCall.idempotencyKey).toBe(firstCall.idempotencyKey);
  });
});

describe('WithdrawForm — why the balance is held, and the way out', () => {
  // Spec 2026-10-15: the held part is money for packs, never "locked" money
  // that spending "unlocks".
  // The For-packs heading row: label, then figure.
  function forPacksHead() {
    return container.querySelector('#withdraw-for-packs > div')?.textContent;
  }

  function expectNoUnlockCopy() {
    expect(container.textContent).not.toMatch(
      /Spend RM|unlock it|unlock the rest|still need to play|Available to withdraw/i,
    );
  }

  it('names the For-packs part and its two lines instead of a bare RM 0.00', async () => {
    await render([READY_ACCOUNT], 0, { available: 5 });
    const split = container.querySelector('#withdraw-for-packs');
    expect(forPacksHead()).toBe('For packsRM 5.00');
    expect(split?.textContent).not.toContain('Not withdrawable');
    expect(split?.textContent).toContain('Bonus credit');
    expect(split?.textContent).toContain('used first');
    expect(split?.textContent).toContain('Still to use on packs');
    expect(split?.textContent).toContain(
      'Can’t go to your bank. Open packs with it. Sell-back money from those packs is withdrawable, except any part paid with bonus credit.',
    );
    // The "RM 174.22 total" read as the customer's deposits (2026-10-14).
    expect(container.querySelector('[role="progressbar"]')).toBeNull();
    expect(split?.querySelector('a[href="/slots"]')?.textContent).toBe(
      'Open packs',
    );
    expectNoUnlockCopy();
    // Nothing free yet: the payout floor is the hold, and it says so.
    expect(container.textContent).toContain('Withdrawable');
    expect(container.textContent).toContain('Minimum withdrawal RM 50.00');
    expect(container.querySelector('#withdraw-hold-reason')?.textContent).toBe(
      'You can withdraw once your withdrawable money reaches RM 50.00 (RM 50.00 more).',
    );
    expect(amountInput().disabled).toBe(true);
    expect(submitButton().disabled).toBe(true);
  });

  it('shows all three figures: withdrawable, bonus credit, still to use on packs', async () => {
    // RM 125 balance, RM 30 of it withdrawable, RM 15 of it bonus credit.
    await render([READY_ACCOUNT], 30, { available: 125, bonus: 15 });
    const split = container.querySelector('#withdraw-for-packs')!;
    expect(forPacksHead()).toBe('For packsRM 95.00');
    const lines = [...split.querySelectorAll('dl > div')].map((row) => [
      row.querySelector('dt')?.textContent,
      row.querySelector('dd')?.textContent,
    ]);
    expect(lines).toEqual([
      ['Bonus creditused first', 'RM 15.00'],
      ['Still to use on packs', 'RM 80.00'],
    ]);
    // Below the floor AND a For-packs part: one hold reason, the gap line,
    // and the disabled field points at it.
    expect(container.querySelectorAll('#withdraw-hold-reason')).toHaveLength(1);
    expect(container.querySelector('#withdraw-hold-reason')?.textContent).toBe(
      'You can withdraw once your withdrawable money reaches RM 50.00 (RM 20.00 more).',
    );
    expect(amountInput().disabled).toBe(true);
    expect(amountInput().getAttribute('aria-describedby')).toBe(
      'withdraw-hold-reason',
    );
  });

  it('shows no For-packs part when the wallet gave no available figure', async () => {
    await render([READY_ACCOUNT], 0);
    expect(container.querySelector('#withdraw-for-packs')).toBeNull();
    expect(container.textContent).toContain('You can withdraw once');
  });

  it('shows no For-packs part when available is below withdrawable', async () => {
    // Deploy skew or a stale read: never a negative "for packs".
    await render([READY_ACCOUNT], 100, { available: 90 });
    expect(container.querySelector('#withdraw-for-packs')).toBeNull();
    expect(container.textContent).not.toMatch(/-RM|RM -/);
  });

  // Only the For-packs part is held, so the rest can leave while the block
  // explains the gap.
  it('lets the withdrawable part leave while the rest is for packs', async () => {
    await render([READY_ACCOUNT], 100, { available: 110.55 });
    expect(container.querySelector('#withdraw-hold-reason')).toBeNull();
    expect(forPacksHead()).toBe('For packsRM 10.55');
    expect(container.textContent).not.toContain('You can withdraw once');
    fillValidForm();
    expect(submitButton().disabled).toBe(false);
  });

  it('a frozen account gets the review notice, never "open packs"', async () => {
    // Freeze outranks every hold (withdrawable.ts): telling a frozen account
    // to open packs would send it down a path that still ends refused.
    await render([READY_ACCOUNT], 0, {
      frozen: true,
      available: 50,
      bonus: 15,
    });
    expect(container.textContent).toContain('under review');
    expect(container.querySelector('#withdraw-for-packs')).toBeNull();
    expect(container.textContent).not.toContain('You can withdraw once');
    expect(container.querySelector('a[href="/contact"]')).not.toBeNull();
    expect(container.querySelector('a[href="/slots"]')).toBeNull();
    expect(amountInput().disabled).toBe(true);
    expect(submitButton().disabled).toBe(true);
  });

  it('an account that never topped up is told to top up, not "reach RM 50"', async () => {
    // The 2026-10-13 ticket: RM 80.97 balance, no top-up ever, and the page
    // said "Reach RM 50 to withdraw" — a goal the customer had already met.
    // RM 20.50 of it is stamped (still to use on packs); the other RM 60.47
    // turns withdrawable at the first top-up with no pack opened.
    await render([READY_ACCOUNT], 0, {
      noTopup: true,
      available: 80.97,
      remaining: 20.5,
    });
    expect(container.querySelectorAll('#withdraw-hold-reason')).toHaveLength(1);
    const hold = container.querySelector('#withdraw-hold-reason');
    expect(hold?.textContent).toContain(
      'Withdrawals and card deliveries start after your first top-up.',
    );
    expect(hold?.textContent).toContain(
      'After your first top-up, RM 60.47 becomes withdrawable.',
    );
    // The minimum is still named, but no "RM X more" goal while on hold.
    expect(container.textContent).toContain('Minimum withdrawal RM 50.00');
    expect(container.textContent).not.toContain('You can withdraw once');
    // The For-packs part shows only the stamped part, not the whole balance.
    expect(forPacksHead()).toBe('For packsRM 20.50');
    expect(
      container.querySelector('#withdraw-for-packs')?.textContent,
    ).toContain('Can’t go to your bank. Open packs with it.');
    // "Sell-back money … is withdrawable" is untrue before a first top-up.
    expect(container.textContent).not.toContain(
      'Sell-back money from those packs',
    );
    expectNoUnlockCopy();
    const topUp = [...(hold?.querySelectorAll('button') ?? [])].find(
      (b) => b.textContent === 'Top up',
    );
    expect(topUp).toBeTruthy();
    act(() => {
      topUp!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(openTopUp).toHaveBeenCalledOnce();
    expect(amountInput().disabled).toBe(true);
    expect(amountInput().getAttribute('aria-describedby')).toBe(
      'withdraw-hold-reason',
    );
    expect(submitButton().disabled).toBe(true);
  });

  it('never topped up with a bonus-only balance: all of it is bonus credit', async () => {
    await render([READY_ACCOUNT], 0, {
      noTopup: true,
      available: 15,
      bonus: 15,
    });
    const split = container.querySelector('#withdraw-for-packs')!;
    expect(forPacksHead()).toBe('For packsRM 15.00');
    const lines = [...split.querySelectorAll('dl > div')].map(
      (row) => row.querySelector('dd')?.textContent,
    );
    expect(lines).toEqual(['RM 15.00', 'RM 0.00']);
    expect(split.textContent).not.toContain('Sell-back money from those packs');
    const hold = container.querySelector('#withdraw-hold-reason')?.textContent;
    expect(hold).toContain('first top-up');
    // Nothing waits on the top-up: bonus credit never becomes withdrawable.
    expect(hold).not.toContain('becomes withdrawable');
  });

  it('never topped up: an unstamped RM 30 prize sale turns withdrawable at the top-up', async () => {
    // RM 45 balance = RM 30 prize sale (no stamp) + RM 15 bonus credit.
    await render([READY_ACCOUNT], 0, {
      noTopup: true,
      available: 45,
      bonus: 15,
      remaining: 0,
    });
    expect(
      container.querySelector('#withdraw-hold-reason')?.textContent,
    ).toContain('After your first top-up, RM 30.00 becomes withdrawable.');
    expect(forPacksHead()).toBe('For packsRM 15.00');
    const lines = [
      ...container.querySelectorAll('#withdraw-for-packs dl > div dd'),
    ].map((dd) => dd.textContent);
    expect(lines).toEqual(['RM 15.00', 'RM 0.00']);
    expectNoUnlockCopy();
  });

  it('never topped up with no remaining figure: promises nothing for the top-up', async () => {
    // Unknown stamped part reads as all still to use — never overstates.
    await render([READY_ACCOUNT], 0, {
      noTopup: true,
      available: 45,
      bonus: 15,
    });
    expect(container.textContent).not.toContain('becomes withdrawable');
    expect(forPacksHead()).toBe('For packsRM 45.00');
  });

  it('a freeze outranks a missing top-up (withdrawable.ts order)', async () => {
    await render([READY_ACCOUNT], 0, { frozen: true, noTopup: true });
    expect(container.textContent).toContain('under review');
    expect(container.textContent).not.toContain('first top-up');
  });

  it('a fully withdrawable wallet raises no hold and no For-packs part', async () => {
    await render([READY_ACCOUNT], 100, { available: 100 });
    expect(container.querySelector('#withdraw-hold-reason')).toBeNull();
    expect(container.querySelector('#withdraw-for-packs')).toBeNull();
    fillValidForm();
    expect(submitButton().disabled).toBe(false);
  });

  it('a "top up at least once" refusal opens the top-up sheet in place', async () => {
    startWithdrawal.mockResolvedValue({
      ok: false,
      error: 'Top up at least once to unlock withdrawals and deliveries.',
    });
    await render();
    fillValidForm();
    await submit();
    const button = container
      .querySelector('[role="alert"]')
      ?.querySelector('button');
    expect(button?.textContent).toBe('Top up');
    act(() => {
      button!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(openTopUp).toHaveBeenCalledOnce();
  });

  it('puts the fix under a backend refusal', async () => {
    startWithdrawal.mockResolvedValue({
      ok: false,
      error:
        'You can withdraw up to RM 28.40 right now. The other RM 10.55 is for opening packs.',
    });
    await render();
    fillValidForm();
    await submit();
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('is for opening packs');
    expect(alert?.querySelector('a[href="/slots"]')?.textContent).toBe(
      'Open packs',
    );
  });

  it('explains a balance under the payout floor instead of snapping the field', async () => {
    await render([READY_ACCOUNT], 30);
    expect(container.textContent).toContain('Minimum withdrawal RM 50.00');
    expect(container.querySelector('#withdraw-hold-reason')?.textContent).toBe(
      'You can withdraw once your withdrawable money reaches RM 50.00 (RM 20.00 more).',
    );
    expect(container.textContent).not.toContain('bonus credit');
    expect(container.textContent).not.toContain('first top-up');
    expect(amountInput().disabled).toBe(true);
    expect(amountInput().getAttribute('aria-describedby')).toBe(
      'withdraw-hold-reason',
    );
    expect(submitButton().disabled).toBe(true);
  });

  // The floor shown and gated on is the rail's: a Singapore account is paid
  // in S$, so its floor is what pays S$30 at today's rate (RM 96.05).
  it("names the S$ rail's own minimum for a Singapore account", async () => {
    getPaymentLimits.mockResolvedValue({
      gateway: 'tgpay',
      deposit: { minRm: 50, maxRm: 10000 },
      withdrawal: { minRm: 50, maxRm: 30000 },
      depositsEnabled: true,
      withdrawalsEnabled: true,
      regional: [
        {
          gateway: 'a3pay',
          currency: 'SGD',
          depositsEnabled: true,
          withdrawalsEnabled: true,
          deposit: { min: 30, max: 3150 },
          withdrawal: { min: 30, max: 10000 },
          withdrawalRm: { minRm: 96.05, maxRm: 30000 },
          rate: { deposit: 3.169804, payout: 3.201662 },
        },
      ],
    });
    await render([{ ...READY_ACCOUNT, id: 'acc_sg', currency: 'SGD' }], 80);
    expect(container.textContent).toContain('Minimum withdrawal RM 96.05');
    expect(container.querySelector('#withdraw-hold-reason')?.textContent).toBe(
      'You can withdraw once your withdrawable money reaches RM 96.05 (RM 16.05 more).',
    );
    expect(amountInput().disabled).toBe(true);
    expect(amountInput().getAttribute('aria-describedby')).toBe(
      'withdraw-hold-reason',
    );
  });

  it('maps each refusal to the screen that fixes it, and nothing for the rest', () => {
    expect(
      withdrawRemedy(
        'Withdrawals are unavailable while your account is under review. Contact support.',
      )?.href,
    ).toBe('/contact');
    expect(
      withdrawRemedy('Add an email address to your account before withdrawing.')
        ?.href,
    ).toBe('/settings');
    expect(
      withdrawRemedy(
        'This bank account is not available for withdrawals yet — try again in about 3 hours.',
      )?.href,
    ).toBe('/bank');
    // Says the bank details are FINE — a /bank link would contradict it.
    expect(
      withdrawRemedy(
        'Withdrawals are temporarily unavailable on our side and your balance has been returned. Your bank details are fine — there is no need to change them. Please try again later.',
      ),
    ).toBeNull();
    // The plain cap already says what to do.
    expect(withdrawRemedy('You can withdraw up to RM 12.34 right now.')).toBe(
      null,
    );
    // Both held refusals (2026-10-15) lead to opening packs.
    expect(
      withdrawRemedy(
        'You can withdraw up to RM 28.40 right now. The other RM 10.55 is for opening packs.',
      ),
    ).toEqual({ href: '/slots', label: 'Open packs' });
    expect(
      withdrawRemedy(
        'Nothing is withdrawable yet. Your RM 45.00 is for opening packs.',
      ),
    ).toEqual({ href: '/slots', label: 'Open packs' });
    // The pre-2026-10-15 wording, still matched for a storefront-first deploy.
    expect(
      withdrawRemedy('Spend RM 5.00 more on packs to unlock withdrawals.'),
    ).toEqual({ href: '/slots', label: 'Open packs' });
    // null href = open the top-up sheet rather than navigate.
    expect(
      withdrawRemedy(
        'Top up at least once to unlock withdrawals and deliveries.',
      ),
    ).toEqual({ href: null, label: 'Top up' });
  });
});

describe('minimumGap', () => {
  it('counts the RM still needed in whole sen, never below 0', () => {
    // 50 - 49.71 is 0.29000000000000625 in floating point.
    expect(minimumGap(50, 49.71)).toBe(0.29);
    expect(minimumGap(96.05, 80)).toBe(16.05);
    expect(minimumGap(50, 0)).toBe(50);
    expect(minimumGap(50, 50)).toBe(0);
    expect(minimumGap(50, 60)).toBe(0);
  });
});

describe('nextAmountText', () => {
  it('floors the cap to whole sen and leaves an unknown balance uncapped', () => {
    // 0.29 * 100 is 28.999… in floating point — must not lose a sen.
    expect(nextAmountText('', '1', 0.29)).toBe('0.29');
    expect(nextAmountText('', '20', 12.345)).toBe('12.34');
    expect(nextAmountText('', '5', 0)).toBe('0.00');
    expect(nextAmountText('', '99999', null)).toBe('99999');
    expect(nextAmountText('7', '', 100)).toBe('');
  });
});

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
  regionalBandText,
  withdrawRemedy,
} from '../WithdrawForm';
import { REGIONAL_RAILS } from '@/lib/regional-rails';

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
  it('points bank-format refusals to saved bank settings', async () => {
    await render();
    for (const error of [
      'Enter the mobile number linked to PayNow, with country code for overseas numbers (digits only).',
      'Withdrawals to Alliance Bank (SG) are unavailable. Choose another bank.',
    ]) {
      expect(withdrawRemedy(error)).toEqual({
        href: '/bank',
        label: 'Manage bank accounts',
      });
    }
  });
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
      'Withdrawals are paused until 6:00 AM (Malaysia time). Your balance is safe — please try again then.',
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

  // A destination's own floor (Touch 'n Go: RM 100) is the band's lower edge
  // once it is chosen — never two different minimums on one screen.
  it("shows a per-bank floor as the band's minimum for that account", async () => {
    const TNG_ACCOUNT = {
      ...READY_ACCOUNT,
      id: 'acc_tng',
      bankCode: 'TNG',
      bankName: "Touch 'n Go",
      minRm: 100,
    };
    await render([READY_ACCOUNT, TNG_ACCOUNT], 1000);
    const status = () => container.querySelector('section')?.textContent;
    expect(status()).toContain('RM 50–RM 50,000 per withdrawal');
    setValue('select[aria-label="Saved bank account"]', TNG_ACCOUNT.id);
    expect(status()).toContain('RM 100–RM 50,000 per withdrawal');
    setValue('input[aria-label="Withdrawal amount in RM"]', '80');
    await submit();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Withdrawals must be between RM 100 and RM 50,000 for Touch 'n Go.",
    );
    expect(startWithdrawal).not.toHaveBeenCalled();
  });

  it("lists one country's saved accounts at a time, switched by flag", async () => {
    const SG_ACCOUNT = {
      ...READY_ACCOUNT,
      id: 'acc_sg',
      bankName: 'DBS Bank',
      currency: 'SGD',
    };
    const select = () =>
      container.querySelector<HTMLSelectElement>(
        'select[aria-label="Saved bank account"]',
      )!;
    const listed = () =>
      [...select().options].map((o) => o.value).filter(Boolean);
    const toggle = () =>
      [...container.querySelectorAll('[role="group"] button')].map(
        (b) =>
          `${b.textContent}${b.getAttribute('aria-pressed') === 'true' ? ' (on)' : ''}`,
      );
    await render([READY_ACCOUNT, SG_ACCOUNT, COOLING_ACCOUNT]);
    expect(toggle()).toEqual(['Malaysia (on)', 'Singapore']);
    expect(listed()).toEqual([READY_ACCOUNT.id, COOLING_ACCOUNT.id]);

    const singapore = [
      ...container.querySelectorAll<HTMLButtonElement>('[role="group"] button'),
    ].find((b) => b.textContent === 'Singapore')!;
    act(() => singapore.click());
    expect(toggle()).toEqual(['Malaysia', 'Singapore (on)']);
    expect(listed()).toEqual([SG_ACCOUNT.id]);
    // Its one usable account is chosen for the customer.
    expect(select().value).toBe(SG_ACCOUNT.id);

    act(() => root.unmount());
    container.remove();
    // The only usable account is Singapore's: preselected, so that flag is on.
    await render([COOLING_ACCOUNT, SG_ACCOUNT]);
    expect(toggle()).toEqual(['Malaysia', 'Singapore (on)']);
    expect(select().value).toBe(SG_ACCOUNT.id);

    act(() => root.unmount());
    container.remove();
    // Keep the bank country visible even when only one is available.
    await render([READY_ACCOUNT]);
    expect(toggle()).toEqual(['Malaysia (on)']);
    expect(listed()).toEqual([READY_ACCOUNT.id]);
  });

  // The country toggle, past the happy path. The S$ rail is open and priced.
  const SG_LIMITS = {
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
  };
  const DBS = {
    ...READY_ACCOUNT,
    id: 'acc_dbs',
    bankName: 'DBS Bank',
    currency: 'SGD',
  };
  const OCBC = {
    ...READY_ACCOUNT,
    id: 'acc_ocbc',
    bankName: 'OCBC Bank',
    currency: 'SGD',
  };
  const pill = (name: string) =>
    [
      ...container.querySelectorAll<HTMLButtonElement>('[role="group"] button'),
    ].find((b) => b.textContent === name)!;
  const accountSelect = () =>
    container.querySelector<HTMLSelectElement>(
      'select[aria-label="Saved bank account"]',
    )!;
  const bandLine = () => container.querySelector('section')?.textContent ?? '';

  it('blocks an existing account whose number does not match its bank country', async () => {
    getPaymentLimits.mockResolvedValue(SG_LIMITS);
    const invalid = {
      ...DBS,
      bankCode: 'MBBESGSG',
      bankName: 'Maybank (SG)',
      accountNumber: '123456789012',
      supported: false,
      unavailableReason:
        'Maybank (SG) account numbers must be 11 digits. Remove this account and add it again with the correct bank country and account number.',
    };
    await render([invalid], 1000);
    expect(
      accountSelect().querySelector<HTMLOptionElement>(
        `option[value="${invalid.id}"]`,
      )?.disabled,
    ).toBe(true);
    expect(container.textContent).toContain(invalid.unavailableReason);
    expect(submitButton().disabled).toBe(true);
    setValue('select[aria-label="Saved bank account"]', invalid.id);
    setValue('input[aria-label="Withdrawal amount in RM"]', '100');
    await submit();
    expect(startWithdrawal).not.toHaveBeenCalled();
  });

  it("shows the Singapore rail's band as soon as its flag is on", async () => {
    getPaymentLimits.mockResolvedValue(SG_LIMITS);
    await render([READY_ACCOUNT, DBS, OCBC], 1000);
    act(() => pill('Singapore').click());
    // Two Singapore accounts: none is chosen for the customer...
    expect(accountSelect().value).toBe('');
    // ...but the band is already the S$ rail's, not the RM gateway's.
    expect(bandLine()).toContain(
      'RM 96.05–RM 30,000 per withdrawal (Singapore limit S$30–S$10,000)',
    );
  });

  it('re-tapping the country on show keeps the chosen account', async () => {
    const CIMB = { ...READY_ACCOUNT, id: 'acc_cimb', bankName: 'CIMB Bank' };
    await render([READY_ACCOUNT, CIMB, DBS]);
    setValue('select[aria-label="Saved bank account"]', CIMB.id);
    act(() => pill('Malaysia').click());
    expect(accountSelect().value).toBe(CIMB.id);
  });

  it('opens on the country with an account ready to pay', async () => {
    await render([COOLING_ACCOUNT, DBS, OCBC]);
    expect(pill('Singapore').getAttribute('aria-pressed')).toBe('true');
    expect(accountSelect().options[0]?.textContent).toBe(
      'Choose a saved account',
    );
    // Malaysia's only account is still cooling off: say so, and why.
    act(() => pill('Malaysia').click());
    expect(accountSelect().options[0]?.textContent).toBe(
      'No account is available yet',
    );
    expect(container.textContent).toContain(
      'New bank accounts need a short wait before first use',
    );
  });

  it("clears one country's refusal when the customer switches country", async () => {
    await render([READY_ACCOUNT, DBS], 1000);
    fillValidForm('20');
    await submit();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'Withdrawals must be between RM 50 and RM 50,000.',
    );
    act(() => pill('Singapore').click());
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  // The hold names the floor the band shows: a Touch 'n Go account's own.
  it("holds the form under a chosen account's own floor, naming the bank", async () => {
    const TNG = {
      ...READY_ACCOUNT,
      id: 'acc_tng',
      bankCode: 'TNG',
      bankName: "Touch 'n Go",
      minRm: 100,
    };
    await render([READY_ACCOUNT, TNG], 60);
    expect(amountInput().disabled).toBe(false);
    setValue('select[aria-label="Saved bank account"]', TNG.id);
    expect(bandLine()).toContain('RM 100–RM 50,000 per withdrawal');
    expect(container.querySelector('#withdraw-hold-reason')?.textContent).toBe(
      "You can withdraw to Touch 'n Go once your withdrawable money reaches RM 100 (RM 40.00 more).",
    );
    expect(amountInput().disabled).toBe(true);
    // Maybank's floor is the gateway's RM 50: the form opens again.
    setValue('select[aria-label="Saved bank account"]', READY_ACCOUNT.id);
    expect(container.querySelector('#withdraw-hold-reason')).toBeNull();
    expect(amountInput().disabled).toBe(false);
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
  // Spec 2026-10-15 (spend first): using the money for packs unlocks
  // withdrawals — but never the old partial "unlock it / the rest" wording.
  const NB = ' ';
  const PRIMARY = 'bg-neutral-50';

  function expectNoUnlockCopy() {
    expect(container.textContent).not.toMatch(
      /unlock it|unlock the rest|still need to play|Available to withdraw/i,
    );
  }
  const amountField = () =>
    container.querySelector('input[aria-label="Withdrawal amount in RM"]');
  const steps = () =>
    container.querySelector('#withdraw-hold-reason ol')?.textContent ?? '';
  const status = () => container.querySelector('section')?.textContent ?? '';
  /** The "Your money" rows, label → figure. */
  function moneyRows() {
    return Object.fromEntries(
      [...container.querySelectorAll('#withdraw-money dl div')]
        .filter((d) => d.querySelector(':scope > dt'))
        .map((d) => [
          d.querySelector('dt')?.textContent,
          d.querySelector('dd')?.textContent,
        ]),
    );
  }

  it('can withdraw: the big figure, the minimum, then the form', async () => {
    await render([READY_ACCOUNT], 120, {
      available: 135,
      bonus: 15,
      remaining: 0,
    });
    expect(status()).toBe(
      'RM 120.00WithdrawableRM 50–RM 50,000 per withdrawal',
    );
    expect(container.querySelector('#withdraw-hold-reason')).toBeNull();
    expect(amountField()).not.toBeNull();
    expect(container.querySelector('#withdraw-hold-reason ol')).toBeNull();
    expect(moneyRows()).toMatchObject({
      Balance: 'RM 135.00',
      Withdrawable: 'RM 120.00',
      'For packs': 'RM 15.00',
    });
    expect(moneyRows()).not.toHaveProperty('Withdrawable later');
    fillValidForm();
    expect(submitButton().disabled).toBe(false);
  });

  it('slab RM 300 sold, RM 50 top-up unspent: the steps replace the form', async () => {
    await render([READY_ACCOUNT], 0, { available: 350, remaining: 50 });
    expect(status()).toContain('RM 0.00 withdrawable');
    expect(container.querySelectorAll('#withdraw-hold-reason')).toHaveLength(1);
    expect(steps()).toContain('Top up onceDone');
    expect(steps()).toContain(`Use RM${NB}50.00 more on packs`);
    expect(container.textContent).toContain(
      'Then your balance, except bonus credit, can go to your bank.',
    );
    const open = container.querySelector(
      '#withdraw-hold-reason a[href="/slots"]',
    );
    expect(open?.textContent).toBe('Open packs');
    expect(open?.className).toContain(PRIMARY);
    // Nothing to fill in, and no second white pill competing.
    expect(amountField()).toBeNull();
    expect(
      [...container.querySelectorAll('button')].some((b) =>
        /^Withdraw/.test(b.textContent ?? ''),
      ),
    ).toBe(false);
    expect(container.querySelectorAll(`.${PRIMARY}`)).toHaveLength(1);
    // A payable account is saved: no bank nudge.
    expect(container.querySelector('a[href="/bank"]')).toBeNull();
    expect(moneyRows()).toMatchObject({
      Balance: 'RM 350.00',
      Withdrawable: 'RM 0.00',
      'Withdrawable later': 'RM 300.00',
      'For packs': 'RM 50.00',
      'Still to use on packs': 'RM 50.00',
    });
    expectNoUnlockCopy();
  });

  it('locked with no payable account: one quiet nudge to save one now', async () => {
    await render([COOLING_ACCOUNT], 0, { available: 350, remaining: 50 });
    const links = container.querySelectorAll('a[href="/bank"]');
    expect(links).toHaveLength(1);
    expect(links[0]?.textContent).toBe(`Save your bank account now${NB}→`);
    expect(links[0]?.className).not.toContain(PRIMARY);
    // The big "Add a bank account" pill stays off while locked.
    expect(container.textContent).not.toContain('Add a bank account');
  });

  it('locked with bonus credit: step 2 counts the bonus packs use first', async () => {
    await render([READY_ACCOUNT], 0, {
      available: 125,
      bonus: 15,
      remaining: 80,
    });
    expect(steps()).toContain(`Use RM${NB}95.00 more on packs`);
    expect(steps()).toContain(
      `This includes your RM${NB}15.00 bonus credit, which packs use first.`,
    );
    expect(steps()).not.toContain('Delivery fees');
  });

  it('locked after a delivery fee took the cash: the whole spend, and why', async () => {
    await render([READY_ACCOUNT], 0, {
      available: 10,
      bonus: 10,
      remaining: 20,
    });
    expect(steps()).toContain(`Use RM${NB}30.00 more on packs`);
    expect(steps()).toContain('Delivery fees don’t count as pack spending.');
    expect(moneyRows()).not.toHaveProperty('Withdrawable later');
  });

  it('an older backend paying part out is not locked: the form stays open', async () => {
    await render([READY_ACCOUNT], 100, {
      available: 190,
      bonus: 10,
      remaining: 80,
    });
    expect(container.querySelector('#withdraw-hold-reason')).toBeNull();
    expect(container.querySelector('#withdraw-hold-reason ol')).toBeNull();
    fillValidForm();
    expect(submitButton().disabled).toBe(false);
  });

  it('never topped up: Top Up is the one white pill, then Open packs', async () => {
    // The 2026-10-13 ticket: RM 80.97 balance, no top-up ever, and the page
    // said "Reach RM 50 to withdraw" — a goal the customer had already met.
    await render([READY_ACCOUNT], 0, {
      noTopup: true,
      available: 80.97,
      remaining: 20.5,
    });
    expect(container.querySelectorAll('#withdraw-hold-reason')).toHaveLength(1);
    expect(steps()).toContain('Top up onceFrom RM 30');
    expect(steps()).toContain('Use your top-up on packs');
    expect(steps()).toContain(`Plus RM${NB}20.50 you already have for packs.`);
    expect(container.textContent).not.toContain('You can withdraw once');
    const topUp = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === 'Top Up',
    );
    expect(topUp?.className).toContain(PRIMARY);
    act(() => {
      topUp!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(openTopUp).toHaveBeenCalledOnce();
    expect(
      container.querySelector('#withdraw-hold-reason a[href="/slots"]')
        ?.className,
    ).not.toContain(PRIMARY);
    expect(container.querySelectorAll(`.${PRIMARY}`)).toHaveLength(1);
    expect(amountField()).toBeNull();
    expect(moneyRows()).toMatchObject({
      'Withdrawable later': 'RM 60.47',
      'For packs': 'RM 20.50',
    });
    expectNoUnlockCopy();
  });

  it('frozen: one message and nothing else', async () => {
    await render([READY_ACCOUNT], 0, {
      frozen: true,
      noTopup: true,
      available: 50,
      bonus: 15,
      remaining: 50,
    });
    const holds = container.querySelectorAll('#withdraw-hold-reason');
    expect(holds).toHaveLength(1);
    expect(holds[0]?.textContent).toContain('under review');
    expect(container.querySelector('a[href="/contact"]')).not.toBeNull();
    expect(container.querySelector('a[href="/slots"]')).toBeNull();
    expect(container.querySelector('details')).toBeNull();
    expect(amountField()).toBeNull();
    expect(container.textContent).not.toContain('Top up once');
  });

  it('a missing top-up outranks a lock: one hold reason, the top-up steps', async () => {
    await render([READY_ACCOUNT], 0, {
      noTopup: true,
      available: 50,
      remaining: 50,
    });
    expect(container.querySelectorAll('#withdraw-hold-reason')).toHaveLength(1);
    expect(steps()).toContain('From RM 30');
  });

  it('a fully withdrawable wallet raises no hold and no steps', async () => {
    await render([READY_ACCOUNT], 100, { available: 100 });
    expect(container.querySelector('#withdraw-hold-reason')).toBeNull();
    expect(moneyRows()).toMatchObject({ 'For packs': 'RM 0.00' });
    fillValidForm();
    expect(submitButton().disabled).toBe(false);
  });

  it('the rules sit collapsed below, said once', async () => {
    await render([READY_ACCOUNT], 100, { available: 100 });
    const how = [...container.querySelectorAll('details')].find((d) =>
      d.querySelector('summary')?.textContent?.includes('How withdrawals work'),
    );
    expect(how?.open).toBe(false);
    expect(how?.querySelectorAll('li')).toHaveLength(3);
    expect(container.textContent).not.toContain('Sell-back money reaches');
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
    expect(container.textContent).toContain('RM 50–RM 50,000 per withdrawal');
    expect(container.querySelector('#withdraw-hold-reason')?.textContent).toBe(
      'You can withdraw once your withdrawable money reaches RM 50 (RM 20.00 more).',
    );
    // The status block names only the floor (the rules below are collapsed).
    const status = container.querySelector('section')?.textContent;
    expect(status).not.toContain('bonus credit');
    expect(status).not.toContain('top-up');
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
    // The RM band it is judged by, and the rail's own S$ limit — not "what
    // reaches the bank": RM 30,000 pays ~S$9,370, never S$10,000.
    expect(container.textContent).toContain(
      'RM 96.05–RM 30,000 per withdrawal (Singapore limit S$30–S$10,000)',
    );
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
    // Same for the payout partner's no-provider refusal.
    expect(
      withdrawRemedy(
        'Withdrawals are temporarily unavailable from our payout partner. Your balance has been returned and your bank details are fine. Please try again later.',
      ),
    ).toBeNull();
    // The plain cap already says what to do.
    expect(withdrawRemedy('You can withdraw up to RM 12.34 right now.')).toBe(
      null,
    );
    // The backend's exact refusals (withdrawalGateError, spend first): the
    // locked one leads to opening packs; the no-top-up one also mentions
    // "money for packs" but its fix is the top-up, so that rule comes first.
    expect(
      withdrawRemedy(
        "Withdrawals unlock once you've used RM 50.00 more on packs. Then your balance, except bonus credit, can be withdrawn.",
      ),
    ).toEqual({ href: '/slots', label: 'Open packs' });
    expect(
      withdrawRemedy(
        'Top up at least once to unlock deliveries. To withdraw, you also need to use all your money for packs.',
      ),
    ).toEqual({ href: null, label: 'Top up' });
    // An earlier spend-first wording, kept for deploy skew.
    expect(
      withdrawRemedy(
        "Withdrawals unlock once you've used your RM 50.00 for packs. Open packs with it, then your balance can be withdrawn.",
      ),
    ).toEqual({ href: '/slots', label: 'Open packs' });
    // Older held refusals (deploy skew) still lead to opening packs.
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

describe('regionalBandText', () => {
  it('names whichever edges the rail sets, cents only when there are some', () => {
    const ui = REGIONAL_RAILS.SGD!;
    expect(regionalBandText({ min: 30, max: 10000 }, ui)).toBe(
      'Singapore limit S$30–S$10,000',
    );
    expect(regionalBandText({ min: 30, max: null }, ui)).toBe(
      'Singapore limit from S$30',
    );
    expect(regionalBandText({ min: null, max: 10000 }, ui)).toBe(
      'Singapore limit up to S$10,000',
    );
    expect(regionalBandText({ min: null, max: null }, ui)).toBeNull();
    expect(regionalBandText({ min: 30, max: 9370.5 }, ui)).toBe(
      'Singapore limit S$30–S$9,370.50',
    );
  });

  it('does not repeat USDT, whose "country" is its own symbol', () => {
    expect(regionalBandText({ min: 10, max: 5000 }, REGIONAL_RAILS.USDT!)).toBe(
      'limit USDT 10–USDT 5,000',
    );
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

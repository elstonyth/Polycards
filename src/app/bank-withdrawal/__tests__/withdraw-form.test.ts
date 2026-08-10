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
vi.mock('@/lib/actions/vault', () => ({
  startWithdrawal: (...args: unknown[]) => startWithdrawal(...args),
  fetchSavedBankAccounts: () => fetchSavedBankAccounts(),
}));

// The form repaints the header balance on success, so it now reads useTopUp —
// which throws outside its provider. Stubbing the hook keeps these cases about
// the money guards instead of dragging the whole app-shell provider stack in.
const applyBalance = vi.fn();
vi.mock('@/components/app-shell/TopUpProvider', () => ({
  useTopUp: () => ({ applyBalance }),
}));

import WithdrawForm from '../WithdrawForm';

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

async function render(accounts: unknown[] = [READY_ACCOUNT]) {
  fetchSavedBankAccounts.mockResolvedValue({ ok: true, accounts });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(createElement(WithdrawForm, { withdrawable: 100 }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
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

  it.each(['49', '50001'])(
    'rejects RM %s in the form without touching the backend',
    async (amount) => {
      await render();
      fillValidForm(amount);
      await submit();
      expect(container.querySelector('[role="alert"]')?.textContent).toBe(
        'Withdrawals must be between RM 50 and RM 50,000.',
      );
      expect(startWithdrawal).not.toHaveBeenCalled();
    },
  );

  it('rejects an amount above the withdrawable figure without touching the backend', async () => {
    await render();
    fillValidForm('200');
    await submit();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'That is more than you can withdraw right now.',
    );
    expect(startWithdrawal).not.toHaveBeenCalled();
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
    // details from the customer's own saved list.
    expect(startWithdrawal).toHaveBeenCalledExactlyOnceWith({
      amount: 50,
      accountId: READY_ACCOUNT.id,
    });
    // The payout debits the balance server-side; the form must repaint it, or
    // the header chip stays stale and the Me tab's money dot never lights until
    // a focus event.
    expect(applyBalance).toHaveBeenCalledWith(50);
    const text = container.textContent ?? '';
    expect(text).toContain('RM 50.00 ON ITS WAY');
    // The transfer is asynchronous — the form must not claim it completed.
    expect(text).not.toMatch(/has been sent|paid|complete/i);
    // And it must say what happens if the bank bounces it.
    expect(text).toContain('returns to your balance');
    expect(text).toContain('W2026072200000001');
    expect(text).toContain('RM 50.00');
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
});

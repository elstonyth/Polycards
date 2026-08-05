// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// The withdrawal form debits real balance on submit, so these pin the money
// behaviors: the band guard, the balance guard, the no-overpromise copy
// ("on its way", never "paid"), and that nothing is submitted while invalid.

const fetchWithdrawBanks = vi.fn();
const startWithdrawal = vi.fn();
// Both arrived with the saved-accounts prefill. These cases are about the money
// guards, not the picker, so the read defaults to "no saved accounts" — also the
// no-prefill path, leaving every assertion below reading the same empty form it
// always did. The write is on the submit path (the save checkbox defaults on)
// and is fire-and-forget, so it only has to resolve rather than throw; a missing
// export here surfaces as the form's generic error and masks the real assertion.
const fetchSavedBankAccounts = vi.fn(async () => ({ ok: true, accounts: [] }));
const addSavedBankAccount = vi.fn(async (_input: unknown) => ({
  ok: true,
  accounts: [],
}));
vi.mock('@/lib/actions/vault', () => ({
  fetchWithdrawBanks: (...args: unknown[]) => fetchWithdrawBanks(...args),
  startWithdrawal: (...args: unknown[]) => startWithdrawal(...args),
  fetchSavedBankAccounts: () => fetchSavedBankAccounts(),
  addSavedBankAccount: (input: unknown) => addSavedBankAccount(input),
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

beforeEach(async () => {
  vi.clearAllMocks();
  fetchWithdrawBanks.mockResolvedValue({
    ok: true,
    banks: [
      { bankCode: 'MBB', bankName: 'Maybank' },
      { bankCode: 'CIMB', bankName: 'CIMB Bank' },
    ],
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(createElement(WithdrawForm, { withdrawable: 100 }));
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
  setValue('select[aria-label="Destination bank"]', 'MBB');
  setValue('input[aria-label="Account number"]', '1234567890');
  setValue('input[aria-label="Account holder name"]', 'AHMAD BIN ALI');
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
  it('loads the bank list through the backend proxy', () => {
    expect(fetchWithdrawBanks).toHaveBeenCalledOnce();
    const options = [...container.querySelectorAll('option')].map(
      (o) => o.textContent,
    );
    expect(options).toContain('Maybank');
    expect(options).toContain('CIMB Bank');
  });

  it('keeps the button disabled until every field is valid', () => {
    expect(submitButton().disabled).toBe(true);
    fillValidForm();
    expect(submitButton().disabled).toBe(false);
  });

  it.each(['49', '50001'])(
    'rejects RM %s in the form without touching the backend',
    async (amount) => {
      fillValidForm(amount);
      await submit();
      expect(container.querySelector('[role="alert"]')?.textContent).toBe(
        'Withdrawals must be between RM 50 and RM 50,000.',
      );
      expect(startWithdrawal).not.toHaveBeenCalled();
    },
  );

  it('rejects an amount above the withdrawable figure without touching the backend', async () => {
    fillValidForm('200');
    await submit();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'That is more than you can withdraw right now.',
    );
    expect(startWithdrawal).not.toHaveBeenCalled();
  });

  it('submits and shows the async success state — "on its way", never "paid"', async () => {
    startWithdrawal.mockResolvedValue({
      ok: true,
      amount: 50,
      balance: 50,
      reference: 'W2026072200000001',
    });
    fillValidForm();
    await submit();

    expect(startWithdrawal).toHaveBeenCalledExactlyOnceWith({
      amount: 50,
      bankCode: 'MBB',
      accountNumber: '1234567890',
      accountHolderName: 'AHMAD BIN ALI',
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

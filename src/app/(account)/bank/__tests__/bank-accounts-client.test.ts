// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// The add-account form lists one country's payout banks at a time, picked by
// flag, before accepting bank details. The backend supplies account lengths.

const fetchSavedBankAccounts = vi.fn();
const fetchWithdrawBanks = vi.fn();
const addSavedBankAccount = vi.fn();
vi.mock('@/lib/actions/vault', () => ({
  fetchSavedBankAccounts: () => fetchSavedBankAccounts(),
  fetchWithdrawBanks: () => fetchWithdrawBanks(),
  addSavedBankAccount: (...args: unknown[]) => addSavedBankAccount(...args),
  getPaymentLimits: vi.fn(() => new Promise(() => {})),
}));

import { BankAccountsClient } from '../BankAccountsClient';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const MY = [
  {
    bankCode: 'MBB',
    bankName: 'Maybank',
    currency: 'MYR',
    accountLengths: [12],
  },
  {
    bankCode: 'CIMB',
    bankName: 'CIMB Bank',
    currency: 'MYR',
    accountLengths: [10, 14],
  },
];
const SG = [
  {
    bankCode: 'DBSSSGSG',
    bankName: 'DBS Bank',
    currency: 'SGD',
    accountLengths: [10],
  },
  {
    bankCode: 'MBBESGSG',
    bankName: 'Maybank (SG)',
    currency: 'SGD',
    accountLengths: [11],
  },
];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  fetchSavedBankAccounts.mockResolvedValue({ ok: true, accounts: [] });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function openAddForm(banks: unknown[]) {
  fetchWithdrawBanks.mockResolvedValue({ ok: true, banks });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(createElement(BankAccountsClient));
  });
  const add = [...container.querySelectorAll('button')].find(
    (b) => b.textContent === 'Add bank account',
  )!;
  act(() => add.click());
}

const listed = () =>
  [
    ...container.querySelectorAll<HTMLOptionElement>(
      'select[aria-label="Bank"] option',
    ),
  ]
    .map((o) => o.textContent)
    .slice(1);
const countryButton = (name: string) =>
  [
    ...container.querySelectorAll<HTMLButtonElement>('[role="group"] button'),
  ].find((b) => b.textContent === name);

function setValue(label: string, value: string) {
  const input = container.querySelector<HTMLInputElement | HTMLSelectElement>(
    `[aria-label="${label}"]`,
  )!;
  const isSelect = input instanceof HTMLSelectElement;
  act(() => {
    Object.getOwnPropertyDescriptor(
      isSelect ? HTMLSelectElement.prototype : HTMLInputElement.prototype,
      'value',
    )!.set!.call(input, value);
    input.dispatchEvent(
      new Event(isSelect ? 'change' : 'input', { bubbles: true }),
    );
  });
}

const saveButton = () =>
  [...container.querySelectorAll('button')].find(
    (button) => button.textContent === 'Save account',
  )!;

describe('BankAccountsClient — bank country', () => {
  it('accepts published five-digit corporate accounts and preserves leading zeros', async () => {
    await openAddForm([
      {
        bankCode: 'SCBLMYKX',
        bankName: 'Standard Chartered',
        currency: 'MYR',
        accountLengths: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17],
      },
    ]);
    act(() => countryButton('Malaysia')!.click());
    setValue('Bank', 'SCBLMYKX');
    setValue('Account holder name', 'Test Customer');
    setValue('Confirm account holder name', 'Test Customer');
    setValue('Account number', '0012');
    expect(saveButton().disabled).toBe(true);
    setValue('Account number', '00123');
    expect(saveButton().disabled).toBe(false);
    addSavedBankAccount.mockResolvedValue({ ok: true, accounts: [] });
    await act(async () => saveButton().click());
    expect(addSavedBankAccount).toHaveBeenCalledWith(
      expect.objectContaining({ accountNumber: '00123' }),
    );
  });

  it('applies the PayNow mobile pattern and guidance supplied by the backend', async () => {
    const accountHint =
      'Enter the mobile number linked to PayNow, with country code for overseas numbers (digits only).';
    await openAddForm([
      {
        bankCode: 'PAYNOWSG',
        bankName: 'PayNow (mobile number)',
        currency: 'SGD',
        accountLengths: [7, 8, 9, 10, 11, 12, 13, 14, 15],
        accountPattern: '^[1-9][0-9]{6,14}$',
        accountHint,
      },
    ]);
    act(() => countryButton('Singapore')!.click());
    setValue('Bank', 'PAYNOWSG');
    setValue('Account holder name', 'Test Customer');
    setValue('Confirm account holder name', 'Test Customer');
    setValue('Account number', '0123456789');
    expect(saveButton().disabled).toBe(true);
    expect(
      container.querySelector('#bank-account-number-hint')?.textContent,
    ).toBe(accountHint);
    for (const number of ['91234567', '6591234567', '60123456789']) {
      setValue('Account number', number);
      expect(saveButton().disabled).toBe(false);
    }
  });

  it('requires country selection before listing banks', async () => {
    await openAddForm([...MY, ...SG]);
    const bank = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Bank"]',
    )!;
    expect(bank.disabled).toBe(true);
    expect(listed()).toEqual([]);
    expect(saveButton().disabled).toBe(true);
    act(() => countryButton('Malaysia')!.click());
    expect(countryButton('Malaysia')?.getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(listed()).toEqual(['Maybank', 'CIMB Bank']);
    act(() => countryButton('Singapore')!.click());
    expect(countryButton('Singapore')?.getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(listed()).toEqual(['DBS Bank', 'Maybank (SG)']);
  });

  it('still names and requires the country when only Malaysia is available', async () => {
    await openAddForm(MY);
    expect(countryButton('Malaysia')?.getAttribute('aria-pressed')).toBe(
      'false',
    );
    expect(listed()).toEqual([]);
    act(() => countryButton('Malaysia')!.click());
    expect(listed()).toEqual(['Maybank', 'CIMB Bank']);
  });

  it('drops the picked bank when the country changes, not on a re-tap', async () => {
    await openAddForm([...MY, ...SG]);
    act(() => countryButton('Malaysia')!.click());
    const select = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Bank"]',
    )!;
    const pick = (code: string) =>
      act(() => {
        Object.getOwnPropertyDescriptor(
          HTMLSelectElement.prototype,
          'value',
        )!.set!.call(select, code);
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
    pick('MBB');
    setValue('Account number', '123456789012');
    act(() => countryButton('Malaysia')!.click());
    expect(select.value).toBe('MBB');
    expect(
      container.querySelector<HTMLInputElement>(
        '[aria-label="Account number"]',
      )!.value,
    ).toBe('123456789012');
    // A Maybank code must never ride along under the Singapore list.
    act(() => countryButton('Singapore')!.click());
    expect(select.value).toBe('');
    expect(
      container.querySelector<HTMLInputElement>(
        '[aria-label="Account number"]',
      )!.value,
    ).toBe('');
  });

  it('requires an explicit Singapore choice even when no Malaysian bank is offered', async () => {
    await openAddForm(SG);
    expect(countryButton('Singapore')?.getAttribute('aria-pressed')).toBe(
      'false',
    );
    expect(listed()).toEqual([]);
    act(() => countryButton('Singapore')!.click());
    expect(listed()).toEqual(['DBS Bank', 'Maybank (SG)']);
  });

  it('blocks a Malaysian-length Maybank number under Singapore before saving', async () => {
    await openAddForm([...MY, ...SG]);
    act(() => countryButton('Singapore')!.click());
    setValue('Bank', 'MBBESGSG');
    setValue('Account holder name', 'Test Customer');
    setValue('Confirm account holder name', 'Test Customer');
    setValue('Account number', '123456789012');
    expect(saveButton().disabled).toBe(true);
    expect(container.textContent).toContain(
      'Maybank (SG) account numbers are 11 digits',
    );
    expect(
      container
        .querySelector('[aria-label="Account number"]')
        ?.getAttribute('aria-invalid'),
    ).toBe('true');
    act(() => saveButton().click());
    expect(addSavedBankAccount).not.toHaveBeenCalled();

    setValue('Account number', '12345678901');
    expect(saveButton().disabled).toBe(false);
    addSavedBankAccount.mockResolvedValue({ ok: true, accounts: [] });
    await act(async () => saveButton().click());
    expect(addSavedBankAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        bankCode: 'MBBESGSG',
        accountNumber: '12345678901',
      }),
    );
  });

  it('accepts Malaysian Maybank length and keeps the server refusal visible', async () => {
    await openAddForm(MY);
    act(() => countryButton('Malaysia')!.click());
    setValue('Bank', 'MBB');
    setValue('Account holder name', 'Test Customer');
    setValue('Confirm account holder name', 'Test Customer');
    setValue('Account number', '12345678901');
    expect(saveButton().disabled).toBe(true);
    setValue('Account number', '123456789012');
    expect(saveButton().disabled).toBe(false);
    addSavedBankAccount.mockResolvedValue({
      ok: false,
      error: 'This account is already linked.',
    });
    await act(async () => saveButton().click());
    expect(container.textContent).toContain('This account is already linked.');
  });

  it('validates multi-length banks and clears account number when changing bank', async () => {
    await openAddForm(MY);
    act(() => countryButton('Malaysia')!.click());
    setValue('Bank', 'CIMB');
    setValue('Account holder name', 'Test Customer');
    setValue('Confirm account holder name', 'Test Customer');
    for (const value of ['1234567890', '12345678901234']) {
      setValue('Account number', value);
      expect(saveButton().disabled).toBe(false);
    }
    setValue('Account number', '12345678901');
    expect(saveButton().disabled).toBe(true);
    setValue('Bank', 'MBB');
    expect(
      container.querySelector<HTMLInputElement>(
        '[aria-label="Account number"]',
      )!.value,
    ).toBe('');
    expect(saveButton().disabled).toBe(true);
  });

  it('keeps guidance short for banks with many valid account lengths', async () => {
    await openAddForm([
      {
        bankCode: 'HSBCSGSG',
        bankName: 'HSBC (SG)',
        currency: 'SGD',
        accountLengths: [7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18],
      },
    ]);
    act(() => countryButton('Singapore')!.click());
    setValue('Bank', 'HSBCSGSG');
    setValue('Account holder name', 'Test Customer');
    setValue('Confirm account holder name', 'Test Customer');
    setValue('Account number', '1234567890123456');
    expect(saveButton().disabled).toBe(false);
    expect(
      container.querySelector('#bank-account-number-hint')?.textContent,
    ).toBe(
      'Check your bank country and use the account number shown in your banking app, not a card number.',
    );
  });
});

describe('BankAccountsClient — a tied account', () => {
  const SAVED = {
    id: 'acc_1',
    bankCode: 'MBB',
    bankName: 'Maybank',
    accountNumber: '123456789012',
    accountHolderName: 'Tan',
    usableFrom: '2026-01-01T00:00:00.000Z',
    supported: true,
  };

  const mount = async () => {
    fetchWithdrawBanks.mockResolvedValue({ ok: true, banks: MY });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(createElement(BankAccountsClient));
    });
  };

  it('offers no remove, no second account and no way to change it', async () => {
    fetchSavedBankAccounts.mockResolvedValue({ ok: true, accounts: [SAVED] });
    await mount();
    expect(container.textContent).toContain('Maybank');
    expect(container.querySelector('button[aria-label^="Remove"]')).toBeNull();
    expect(container.textContent).not.toContain('Add bank account');
    expect(container.textContent).toContain(
      'One person, one account. A saved bank account cannot be changed later.',
    );
    expect(container.querySelector('a[href="/contact"]')).toBeNull();
  });

  it('shows why a shared account is on hold', async () => {
    fetchSavedBankAccounts.mockResolvedValue({
      ok: true,
      accounts: [
        {
          ...SAVED,
          supported: false,
          unavailableReason:
            'Your bank account is linked to another Polycards account. Contact support to verify it.',
        },
      ],
    });
    await mount();
    expect(container.textContent).toContain('Contact support to verify it');
  });

  it('warns before the save that it cannot be changed later', async () => {
    await mount();
    const add = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === 'Add bank account',
    ) as HTMLButtonElement;
    await act(async () => add.click());
    expect(container.textContent).toContain('cannot be changed later');
    expect(container.textContent).not.toContain('contact support');
  });
});

describe('BankAccountsClient — one account per currency', () => {
  const USDT = {
    bankCode: 'USDTTRC20',
    bankName: 'USDT (TRC20)',
    currency: 'USDT',
    wallet: 'tron',
  };
  const WALLET = {
    id: 'acc_w',
    bankCode: 'USDTTRC20',
    bankName: 'USDT (TRC20)',
    accountNumber: 'TXYZ',
    accountHolderName: 'USDT (TRC20)',
    usableFrom: '2026-01-01T00:00:00.000Z',
    supported: true,
    wallet: 'tron',
  };
  const mountWith = async (accounts: unknown[], banks: unknown[]) => {
    fetchSavedBankAccounts.mockResolvedValue({ ok: true, accounts });
    fetchWithdrawBanks.mockResolvedValue({ ok: true, banks });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(createElement(BankAccountsClient));
    });
  };
  const addButton = () =>
    [...container.querySelectorAll('button')].find(
      (b) => b.textContent === 'Add bank account',
    );

  it('lets a wallet-only customer add a bank, never a second wallet', async () => {
    await mountWith([WALLET], [...MY, ...SG, USDT]);
    act(() => addButton()!.click());
    expect(countryButton('Malaysia')).toBeDefined();
    expect(countryButton('Singapore')).toBeDefined();
    expect(countryButton('USDT')).toBeUndefined();
  });

  it('offers the wallet while none is saved', async () => {
    await mountWith([], [...MY, USDT]);
    act(() => addButton()!.click());
    expect(countryButton('USDT')).toBeDefined();
  });

  it('offers no Add once every currency has its account', async () => {
    await mountWith([WALLET], [USDT]);
    expect(addButton()).toBeUndefined();
  });

  const TNG = {
    bankCode: 'TNGMY',
    bankName: "Touch 'n Go eWallet",
    currency: 'MYR',
    accountLengths: [12],
  };
  const bankOptions = () =>
    [
      ...(container.querySelector<HTMLSelectElement>('[aria-label="Bank"]')
        ?.options ?? []),
    ]
      .map((o) => o.value)
      .filter(Boolean);
  const saved = (bankCode: string, bankName: string) => ({
    id: `acc_${bankCode}`,
    bankCode,
    bankName,
    accountNumber: '123456789012',
    accountHolderName: 'Test Customer',
    usableFrom: '2026-01-01T00:00:00.000Z',
    supported: true,
    currency: 'MYR',
  });

  it("offers Touch 'n Go beside a saved RM bank, never a second RM bank", async () => {
    await mountWith([saved('MBB', 'Maybank')], [...MY, TNG]);
    act(() => addButton()!.click());
    act(() => countryButton('Malaysia')!.click());
    expect(bankOptions()).toEqual(['TNGMY']);
  });

  it("offers RM banks beside a saved Touch 'n Go, never a second one", async () => {
    await mountWith([saved('TNGMY', "Touch 'n Go eWallet")], [...MY, TNG]);
    act(() => addButton()!.click());
    act(() => countryButton('Malaysia')!.click());
    expect(bankOptions()).toEqual(['MBB', 'CIMB']);
  });

  it("keeps RM banks on offer when a saved Touch 'n Go is off the bank list", async () => {
    // Touch 'n Go payouts switched off: the list drops it, and the saved row's
    // own bank code still marks the slot as taken.
    await mountWith([saved('TNGMY', "Touch 'n Go eWallet")], MY);
    act(() => addButton()!.click());
    act(() => countryButton('Malaysia')!.click());
    expect(bankOptions()).toEqual(['MBB', 'CIMB']);
  });

  it('names the saved holder name when another bank is added', async () => {
    await mountWith([saved('MBB', 'Maybank')], [...MY, TNG]);
    act(() => addButton()!.click());
    act(() => countryButton('Malaysia')!.click());
    expect(container.textContent).toContain(
      'Use the same name as your saved bank account: Test Customer.',
    );
  });

  it("offers no Add once the RM bank and Touch 'n Go are both saved", async () => {
    await mountWith(
      [saved('MBB', 'Maybank'), saved('TNGMY', "Touch 'n Go eWallet")],
      [...MY, TNG],
    );
    expect(addButton()).toBeUndefined();
  });
});

describe('BankAccountsClient — holder name typed twice', () => {
  it('stays quiet while the second name is still being typed, and Cancel clears both', async () => {
    await openAddForm(MY);
    act(() => countryButton('Malaysia')!.click());
    setValue('Bank', 'MBB');
    setValue('Account holder name', 'Test Customer');
    setValue('Confirm account holder name', 'test cus');
    expect(container.textContent).not.toContain('The two names do not match');
    expect(
      container
        .querySelector('[aria-label="Confirm account holder name"]')
        ?.getAttribute('autocomplete'),
    ).toBe('off');
    const cancel = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === 'Cancel',
    )!;
    act(() => cancel.click());
    const add = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === 'Add bank account',
    )!;
    act(() => add.click());
    for (const label of [
      'Account holder name',
      'Confirm account holder name',
    ]) {
      expect(
        container.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!
          .value,
      ).toBe('');
    }
  });

  it('keeps Save off until both names match, then sends both', async () => {
    await openAddForm(MY);
    act(() => countryButton('Malaysia')!.click());
    setValue('Bank', 'MBB');
    setValue('Account number', '123456789012');
    setValue('Account holder name', 'Test Customer');
    expect(container.textContent).toContain(
      'Type the name exactly as your bank shows it. If it does not match your bank, the withdrawal will not be paid, so check carefully.',
    );
    expect(saveButton().disabled).toBe(true);
    setValue('Confirm account holder name', 'Test Custmer');
    expect(saveButton().disabled).toBe(true);
    expect(container.textContent).toContain(
      'The two names do not match. Type the same name twice.',
    );
    // Case and spacing are not a mismatch.
    setValue('Confirm account holder name', ' test  customer ');
    expect(saveButton().disabled).toBe(false);
    addSavedBankAccount.mockResolvedValue({ ok: true, accounts: [] });
    await act(async () => saveButton().click());
    expect(addSavedBankAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        accountHolderName: 'Test Customer',
        accountHolderNameConfirm: 'test  customer',
      }),
    );
  });
});

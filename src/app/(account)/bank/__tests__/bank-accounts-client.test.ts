// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// The add-account form lists one country's payout banks at a time, picked by
// flag, before accepting bank details. The backend supplies account lengths.

const fetchWithdrawBanks = vi.fn();
const addSavedBankAccount = vi.fn();
vi.mock('@/lib/actions/vault', () => ({
  fetchSavedBankAccounts: () => Promise.resolve({ ok: true, accounts: [] }),
  fetchWithdrawBanks: () => fetchWithdrawBanks(),
  addSavedBankAccount: (...args: unknown[]) => addSavedBankAccount(...args),
  removeSavedBankAccount: vi.fn(),
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

beforeEach(() => vi.clearAllMocks());

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
    setValue('Account number', '1234567890123456');
    expect(saveButton().disabled).toBe(false);
    expect(
      container.querySelector('#bank-account-number-hint')?.textContent,
    ).toBe(
      'Check your bank country and use the account number shown in your banking app, not a card number.',
    );
  });
});

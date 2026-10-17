// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// The add-account form lists one country's payout banks at a time, picked by
// flag, and offers no toggle while only one country has banks (the backend
// leaves a closed rail's banks out).

const fetchWithdrawBanks = vi.fn();
vi.mock('@/lib/actions/vault', () => ({
  fetchSavedBankAccounts: () => Promise.resolve({ ok: true, accounts: [] }),
  fetchWithdrawBanks: () => fetchWithdrawBanks(),
  addSavedBankAccount: vi.fn(),
  removeSavedBankAccount: vi.fn(),
  getPaymentLimits: vi.fn(() => new Promise(() => {})),
}));

import { BankAccountsClient } from '../BankAccountsClient';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const MY = [
  { bankCode: 'MBB', bankName: 'Maybank', currency: 'MYR' },
  { bankCode: 'CIMB', bankName: 'CIMB Bank', currency: 'MYR' },
];
const SG = [{ bankCode: 'DBSSSGSG', bankName: 'DBS Bank', currency: 'SGD' }];

let container: HTMLDivElement;
let root: Root;

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

describe('BankAccountsClient — bank country', () => {
  it('shows Malaysian banks first and Singapore banks behind their flag', async () => {
    await openAddForm([...MY, ...SG]);
    expect(countryButton('Malaysia')?.getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(listed()).toEqual(['Maybank', 'CIMB Bank']);
    act(() => countryButton('Singapore')!.click());
    expect(countryButton('Singapore')?.getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(listed()).toEqual(['DBS Bank']);
  });

  it('offers no toggle while only one country has banks', async () => {
    await openAddForm(MY);
    expect(container.querySelector('[role="group"]')).toBeNull();
    expect(listed()).toEqual(['Maybank', 'CIMB Bank']);
  });

  it('drops the picked bank when the country changes, not on a re-tap', async () => {
    await openAddForm([...MY, ...SG]);
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
    act(() => countryButton('Malaysia')!.click());
    expect(select.value).toBe('MBB');
    // A Maybank code must never ride along under the Singapore list.
    act(() => countryButton('Singapore')!.click());
    expect(select.value).toBe('');
  });

  it('lists Singapore banks when no Malaysian bank is offered', async () => {
    await openAddForm(SG);
    expect(container.querySelector('[role="group"]')).toBeNull();
    expect(listed()).toEqual(['DBS Bank']);
  });
});

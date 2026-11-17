// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from '../../i18n/en.json';
import { WithdrawalReviewDrawer } from './WithdrawalReviewDrawer';
import { qk } from '../../lib/query-keys';
import type { GatewayWithdrawal, WithdrawalLinks } from '../../lib/admin-rest';

vi.mock('../../lib/admin-rest', () => ({ getWithdrawalLinks: vi.fn() }));

// The review drawer (ADR 0018) renders what the links route returns and keeps
// Approve and Deny with it. Made-up accounts.
const money = { topups: 50, withdrawn: 0, prize_sales: 12.5, balance: 3 };
const links: WithdrawalLinks = {
  withdrawal: {
    id: 'gpw_1',
    amount: 60,
    status: 'held',
    hold_reason: 'shared_device',
    created_at: '2026-11-17T01:00:00.000Z',
    bank_name: 'Maybank',
    last4: '0001',
    holder_name: 'Holder Later',
  },
  account: {
    id: 'cus_later',
    handle: 'LaterOne',
    username: null,
    created_at: '2026-11-16T00:00:00.000Z',
    disabled: false,
    banned: false,
    ...money,
  },
  linked: [
    {
      id: 'cus_first',
      handle: 'FirstOne',
      username: null,
      created_at: '2026-11-10T00:00:00.000Z',
      disabled: false,
      banned: true,
      ...money,
      same_browser: true,
      made_earlier_on_browser: true,
      household_verified: false,
      same_network: true,
      invited_this_account: true,
      invited_by_this_account: false,
    },
  ],
  networks_shared: 1,
  unsigned_requests: false,
  bank_accounts: [
    {
      bank: 'Maybank',
      last4: '0001',
      banned_number: false,
      lifted_for_player: false,
      this_player_payouts: { count: 0, rm: 0 },
      other_accounts: [
        {
          username: null,
          handle: 'BankTwin',
          banned: false,
          disabled: false,
          deleted: false,
          same_holder_name: true,
          payouts: { count: 2, rm: 120 },
        },
      ],
    },
  ],
  same_name_accounts: [
    {
      username: null,
      handle: 'NameTwin',
      banned: false,
      disabled: false,
      deleted: false,
      cleared_as_different_person: false,
      banks: [{ bank: 'CIMB Bank', last4: '7777' }],
    },
  ],
  unverified_peers: 1,
};
const row = { id: 'gpw_1', status: 'held', frozen: false } as GatewayWithdrawal;

beforeAll(async () => {
  await i18next.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
  });
});

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

const mount = (onApprove = vi.fn(), onDeny = vi.fn()) => {
  const client = new QueryClient();
  client.setQueryData(qk.withdrawalLinks('gpw_1'), links);
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      createElement(
        MemoryRouter,
        null,
        createElement(
          QueryClientProvider,
          { client },
          createElement(WithdrawalReviewDrawer, {
            withdrawal: row,
            open: true,
            onOpenChange: () => {},
            canDecide: true,
            busy: false,
            onApprove,
            onDeny,
          }),
        ),
      ),
    );
  });
  return { onApprove, onDeny };
};

describe('WithdrawalReviewDrawer', () => {
  it('shows the account, the linked account, the banks and the same-name accounts', () => {
    mount();
    const text = document.body.textContent ?? '';
    for (const part of [
      'LaterOne',
      'FirstOne',
      'Maybank ••0001',
      'BankTwin',
      'NameTwin',
      'CIMB Bank ••7777',
    ]) {
      expect(text).toContain(part);
    }
  });

  it('approves with the household tick only when it is ticked, and denies from the same panel', () => {
    const { onApprove, onDeny } = mount();
    const buttons = () => [...document.body.querySelectorAll('button')];
    const approve = () =>
      buttons().find((b) => /approve/i.test(b.textContent ?? ''))!;
    act(() => approve().click());
    expect(onApprove).toHaveBeenLastCalledWith(false);
    act(() =>
      (
        document.body.querySelector('#review-household') as HTMLButtonElement
      ).click(),
    );
    act(() => approve().click());
    expect(onApprove).toHaveBeenLastCalledWith(true);
    act(() =>
      buttons()
        .find((b) => /deny/i.test(b.textContent ?? ''))!
        .click(),
    );
    expect(onDeny).toHaveBeenCalledTimes(1);
  });
});

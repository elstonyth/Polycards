// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { VaultItem } from '@/lib/actions/vault';
import type { AddressView } from '@/lib/actions/delivery';

// Every delivery pays its zone's shipping (2026-10-14): vault cards as one
// order (shipping + insurance on their value), each prize card as its own
// order (shipping only). The customer confirms the total before anything is
// requested, and a balance that cannot cover it is sent to top up.

const mocks = vi.hoisted(() => ({
  shipVaultCards: vi.fn(),
  openTopUp: vi.fn(),
  balance: 1000 as number | null,
}));

vi.mock('@/lib/actions/delivery', () => ({
  shipVaultCards: mocks.shipVaultCards,
  addAddress: vi.fn(),
}));
vi.mock('@/components/SlabImage', () => ({
  SlabImage: () => createElement('div'),
}));
vi.mock('@/lib/use-liquid-glass', () => ({
  useLiquidGlass: () => {},
  GLASS_SUBTLE: {},
}));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) =>
    createElement('a', { href }, children),
}));
vi.mock('@/components/app-shell/TopUpProvider', () => ({
  useTopUp: () => ({
    balance: mocks.balance,
    openTopUp: mocks.openTopUp,
    refreshBalance: vi.fn().mockResolvedValue(undefined),
    applyBalance: vi.fn(),
  }),
}));

import RequestDeliveryModal from '../RequestDeliveryModal';

const ADDRESS: AddressView = {
  id: 'addr_1',
  name: 'Tan Kah Meng',
  firstName: 'Tan',
  lastName: 'Kah Meng',
  line1: 'S-11-3A Waltz Residence',
  line2: 'Jalan Awan Besar',
  city: 'Kuala Lumpur',
  province: 'Kuala Lumpur',
  postalCode: '58200',
  countryCode: 'MY',
  phone: '+60123456789',
} as AddressView;

const SG_ADDRESS: AddressView = {
  ...ADDRESS,
  id: 'addr_sg',
  line1: '10 Marina Boulevard',
  line2: '',
  city: 'Singapore',
  province: 'Singapore',
  postalCode: '018983',
  countryCode: 'SG',
} as AddressView;

const item = (pullId: string, source: string, priceMyr: number) =>
  ({ pullId, source, card: { priceMyr } }) as unknown as VaultItem;

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  mocks.balance = 1000;
  mocks.shipVaultCards.mockReset();
  mocks.openTopUp.mockReset();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const render = (items: VaultItem[], addresses: AddressView[] = [ADDRESS]) =>
  act(() =>
    root.render(
      createElement(RequestDeliveryModal, {
        open: true,
        items,
        addresses,
        onClose: () => {},
        onSubmitted: () => {},
      }),
    ),
  );

const button = (text: string | RegExp) =>
  [...host.querySelectorAll('button')].find((b) =>
    typeof text === 'string'
      ? b.textContent === text
      : text.test(b.textContent ?? ''),
  );

describe('RequestDeliveryModal fee preview', () => {
  test('a prize card pays its zone shipping (RM15 West)', () => {
    render([item('pull_r', 'reward', 12)]);
    const text = host.textContent ?? '';
    expect(text).toContain('Prize card shipping (West Malaysia)');
    expect(text).toContain('Total — deducted from balance');
    expect(text).toContain('RM 15.00');
  });

  test('vault cards and a prize: one order plus one prize parcel', () => {
    // RM 190 of vault cards + a RM 500 prize: the prize value never counts
    // toward insurance, so no insurance line.
    render([item('pull_a', 'pack', 190), item('pull_r', 'reward', 500)]);
    const text = host.textContent ?? '';
    expect(text).toContain('Shipping (West Malaysia)');
    expect(text).toContain('RM 30.00');
    expect(text).not.toContain('Insurance');
  });

  test('a Singapore address ships at RM50 per parcel', () => {
    render(
      [item('pull_a', 'pack', 100), item('pull_r', 'reward', 5)],
      [SG_ADDRESS],
    );
    const text = host.textContent ?? '';
    expect(text).toContain('Shipping (Singapore)');
    expect(text).toContain('Prize card shipping (Singapore)');
    expect(text).toContain('RM 100.00');
  });
});

describe('RequestDeliveryModal confirm and balance', () => {
  test('asks to confirm the charge before requesting anything', async () => {
    mocks.shipVaultCards.mockResolvedValue({
      ok: true,
      shippedIds: ['pull_r'],
      skipped: [],
    });
    render([item('pull_r', 'reward', 12)]);
    await act(async () => button('Request delivery')!.click());
    expect(mocks.shipVaultCards).not.toHaveBeenCalled();
    expect(host.textContent).toContain(
      'RM 15.00 will be deducted from your balance',
    );
    await act(async () => button('Confirm & pay RM 15.00')!.click());
    expect(mocks.shipVaultCards).toHaveBeenCalledWith(
      [],
      ['pull_r'],
      'addr_1',
      expect.objectContaining({
        address2: 'Jalan Awan Besar',
        province: 'Kuala Lumpur',
        phone: '+60123456789',
      }),
    );
  });

  test('a balance short of the charge is sent to top up, and cannot ship', async () => {
    mocks.balance = 20;
    render([item('pull_a', 'pack', 100)], [SG_ADDRESS]);
    const text = host.textContent ?? '';
    expect(text).toContain('Not enough credit');
    expect(text).toContain('Top up RM 30.00 or more');
    expect(button('Request delivery')!.disabled).toBe(true);
    await act(async () => button('Top up')!.click());
    expect(mocks.openTopUp).toHaveBeenCalled();
  });

  test('refuses a country we do not ship to', () => {
    render(
      [item('pull_a', 'pack', 100)],
      [{ ...ADDRESS, countryCode: 'TH', postalCode: '10110' } as AddressView],
    );
    expect(host.textContent).toContain(
      'We currently ship within Malaysia and Singapore only',
    );
    expect(button('Request delivery')!.disabled).toBe(true);
  });
});

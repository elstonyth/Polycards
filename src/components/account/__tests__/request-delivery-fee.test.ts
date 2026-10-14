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
  bonus: 0,
  allowance: null as { perDay: number; remaining: number } | null,
}));

vi.mock('@/lib/actions/delivery', () => ({
  shipVaultCards: mocks.shipVaultCards,
  addAddress: vi.fn(),
  getPrizeShippingAllowance: async () => mocks.allowance,
}));
vi.mock('@/lib/actions/wallet', () => ({
  getWallet: async () => ({
    ok: true,
    wallet: { balance: mocks.balance ?? 0, bonus: mocks.bonus },
  }),
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
  mocks.bonus = 0;
  mocks.allowance = null;
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

// Async so the open-time wallet and allowance reads land inside act().
const render = (items: VaultItem[], addresses: AddressView[] = [ADDRESS]) =>
  act(async () =>
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
  test('a prize card pays its zone shipping (RM15 West)', async () => {
    await render([item('pull_r', 'reward', 12)]);
    const text = host.textContent ?? '';
    expect(text).toContain('Prize card shipping (West Malaysia)');
    expect(text).toContain('Total — deducted from balance');
    expect(text).toContain('RM 15.00');
  });

  test('vault cards and a prize: one order plus one prize parcel', async () => {
    // RM 190 of vault cards + a RM 500 prize. Each parcel is insured on its
    // OWN value: the vault order (RM 190) needs none, the prize (RM 500) RM 25.
    await render([item('pull_a', 'pack', 190), item('pull_r', 'reward', 500)]);
    const text = host.textContent ?? '';
    expect(text).toContain('Shipping (West Malaysia)');
    expect(text).not.toContain('Insurance (5% of card value)');
    expect(text).toContain('Prize insurance (5% of card value)');
    // 15 + 15 + 25.
    expect(text).toContain('RM 55.00');
  });

  test('a Singapore address ships at RM50 per parcel', async () => {
    await render(
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
    await render([item('pull_r', 'reward', 12)]);
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
    await render([item('pull_a', 'pack', 100)], [SG_ADDRESS]);
    const text = host.textContent ?? '';
    expect(text).toContain('Not enough credit');
    expect(text).toContain('Top up RM 30.00 or more');
    expect(button('Request delivery')!.disabled).toBe(true);
    await act(async () => button('Top up')!.click());
    expect(mocks.openTopUp).toHaveBeenCalled();
  });

  test('refuses a country we do not ship to', async () => {
    await render(
      [item('pull_a', 'pack', 100)],
      [{ ...ADDRESS, countryCode: 'TH', postalCode: '10110' } as AddressView],
    );
    expect(host.textContent).toContain(
      'We currently ship within Malaysia and Singapore only',
    );
    expect(button('Request delivery')!.disabled).toBe(true);
  });
});

describe('RequestDeliveryModal review fixes', () => {
  test('bonus credit cannot pay shipping: a bonus-heavy balance is sent to top up', async () => {
    mocks.balance = 80;
    mocks.bonus = 60;
    await render([item('pull_a', 'pack', 100)], [SG_ADDRESS]);
    const text = host.textContent ?? '';
    expect(text).toContain('bonus credit can only pay for packs');
    expect(text).toContain('Top up RM 30.00 or more');
    expect(button('Request delivery')!.disabled).toBe(true);
  });

  test("prices and sends only the prizes today's limit lets ship", async () => {
    mocks.allowance = { perDay: 1, remaining: 1 };
    mocks.shipVaultCards.mockResolvedValue({
      ok: true,
      shippedIds: ['pull_a', 'pull_r1'],
      skipped: [],
    });
    await render([
      item('pull_a', 'pack', 100),
      item('pull_r1', 'reward', 10),
      item('pull_r2', 'reward', 10),
    ]);
    const text = host.textContent ?? '';
    // RM15 vault order + ONE prize parcel, not two.
    expect(text).toContain('RM 30.00');
    expect(text).toContain('Prize cards ship 1 per day');
    await act(async () => button('Request delivery')!.click());
    await act(async () => button('Confirm & pay RM 30.00')!.click());
    expect(mocks.shipVaultCards).toHaveBeenCalledWith(
      ['pull_a'],
      ['pull_r1'],
      'addr_1',
      expect.anything(),
    );
  });

  test('insures a prize worth over RM200', async () => {
    await render([item('pull_r', 'reward', 400)]);
    const text = host.textContent ?? '';
    expect(text).toContain('Prize insurance (5% of card value)');
    // RM15 shipping + RM20 insurance.
    expect(text).toContain('RM 35.00');
  });

  test('adding a new address drops a pending confirmation', async () => {
    await render([item('pull_a', 'pack', 100)]);
    await act(async () => button('Request delivery')!.click());
    expect(button(/^Confirm & pay/)).toBeDefined();
    await act(async () => button('+ Add a new address')!.click());
    expect(button(/^Confirm & pay/)).toBeUndefined();
  });
});

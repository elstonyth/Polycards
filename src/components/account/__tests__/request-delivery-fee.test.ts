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
  addAddress: vi.fn(),
  updateAddress: vi.fn(),
  openTopUp: vi.fn(),
  balance: 1000 as number | null,
  bonus: 0,
  allowance: null as { perDay: number; remaining: number } | null,
}));

vi.mock('@/lib/actions/delivery', () => ({
  shipVaultCards: mocks.shipVaultCards,
  addAddress: mocks.addAddress,
  updateAddress: mocks.updateAddress,
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
  mocks.addAddress.mockReset();
  mocks.updateAddress.mockReset();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

// Async so the open-time wallet and allowance reads land inside act().
const render = (
  items: VaultItem[],
  addresses: AddressView[] = [ADDRESS],
  open = true,
) =>
  act(async () =>
    root.render(
      createElement(RequestDeliveryModal, {
        open,
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
    expect(text).toContain('Shipping (West Malaysia)');
    expect(text).toContain('Total — deducted from balance');
    expect(text).toContain('RM 15.00');
  });

  test('vault cards and a prize: one parcel, one shipping fee', async () => {
    // RM 190 of vault cards + a RM 500 prize in ONE parcel (2026-10-23).
    // Shipping once; insurance on each part's own value: none on the vault
    // cards (RM 190), RM 25 on the prize (RM 500).
    await render([item('pull_a', 'pack', 190), item('pull_r', 'reward', 500)]);
    const text = host.textContent ?? '';
    expect(text).toContain('Shipping (West Malaysia)');
    expect(text).toContain('Insurance (5% of card value)');
    expect(text).not.toContain('Prize card shipping');
    // 15 + 25.
    expect(text).toContain('RM 40.00');
  });

  test('a Singapore parcel ships at RM50, prize cards included', async () => {
    await render(
      [item('pull_a', 'pack', 100), item('pull_r', 'reward', 5)],
      [SG_ADDRESS],
    );
    const text = host.textContent ?? '';
    expect(text).toContain('Shipping (Singapore)');
    expect(text).toContain('RM 50.00');
    expect(text).not.toContain('RM 100.00');
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
    expect(mocks.shipVaultCards).toHaveBeenCalledWith([], ['pull_r'], 'addr_1');
  });

  test('a balance short of the charge is sent to top up, and cannot ship', async () => {
    mocks.balance = 20;
    await render([item('pull_a', 'pack', 100)], [SG_ADDRESS]);
    const text = host.textContent ?? '';
    expect(text).toContain('Not enough balance');
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
      'We ship within Malaysia and Singapore only',
    );
    expect(button('Request delivery')!.disabled).toBe(true);
  });

  // 2026-10-20: 74 Malaysian addresses were saved with "60" or "MALAYSIA" as
  // the country back when it was free text. The modal names the bad value and
  // re-opens the address with everything but the country already filled in.
  test('offers to re-enter an address saved with a junk country', async () => {
    await render(
      [item('pull_a', 'pack', 100)],
      [{ ...ADDRESS, countryCode: '60' } as AddressView],
    );
    expect(host.textContent).toContain('This address has “60” as its country');

    await act(async () => button('Fix this address')!.click());

    const input = (label: string) =>
      host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!
        .value;
    expect(input('Address')).toBe(ADDRESS.line1);
    expect(input('Postal code')).toBe(ADDRESS.postalCode);
    const country = host.querySelector<HTMLSelectElement>(
      'select[aria-label="Country"]',
    )!;
    expect(country.value).toBe('');
    expect([...country.options].map((o) => o.textContent)).toEqual([
      'Select country',
      'Malaysia',
      'Singapore',
    ]);

    // Saving repairs the SAME row; a second one would leave the junk behind.
    mocks.updateAddress.mockResolvedValueOnce({ ok: true });
    await act(async () => {
      country.value = 'MY';
      country.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => button('Save address')!.click());
    expect(mocks.updateAddress).toHaveBeenCalledWith(
      'addr_1',
      expect.objectContaining({
        countryCode: 'MY',
        address1: ADDRESS.line1,
        phone: ADDRESS.phone,
      }),
    );
    expect(host.querySelectorAll('input[name="addr"]')).toHaveLength(1);
    expect(host.textContent).not.toContain('as its country');
    expect(host.textContent).toContain('West Malaysia');
  });

  test('opens on a saved address that can ship, not an old junk one', async () => {
    await render(
      [item('pull_a', 'pack', 100)],
      [
        { ...ADDRESS, id: 'addr_junk', countryCode: '60' } as AddressView,
        ADDRESS,
      ],
    );
    expect(host.textContent).not.toContain('as its country');
    expect(button('Request delivery')!.disabled).toBe(false);
  });

  test('a row with no country at all reads plainly, not as ""', async () => {
    await render(
      [item('pull_a', 'pack', 100)],
      [{ ...ADDRESS, countryCode: '' } as AddressView],
    );
    expect(host.textContent).toContain('This address has no country');
  });

  // The sheet has no phone field, so a saved number the action would refuse
  // has to go, or the customer is stuck on an error they cannot act on here.
  test('a repair drops a saved phone the action would refuse', async () => {
    await render(
      [item('pull_a', 'pack', 100)],
      [{ ...ADDRESS, countryCode: '60', phone: '12345' } as AddressView],
    );
    await act(async () => button('Fix this address')!.click());
    const country = host.querySelector<HTMLSelectElement>(
      'select[aria-label="Country"]',
    )!;
    await act(async () => {
      country.value = 'MY';
      country.dispatchEvent(new Event('change', { bubbles: true }));
    });
    mocks.updateAddress.mockResolvedValueOnce({ ok: true });
    await act(async () => button('Save address')!.click());
    const [, saved] = mocks.updateAddress.mock.calls[0]!;
    expect(saved.phone).toBeUndefined();
  });

  // React paints the first option for a value no option has, so a free-text
  // state would read as "Johor" while the old text is still what saves.
  test('a repair shows the placeholder for a state not on the list', async () => {
    await render(
      [item('pull_a', 'pack', 100)],
      [{ ...ADDRESS, countryCode: '60', province: 'KL' } as AddressView],
    );
    await act(async () => button('Fix this address')!.click());
    expect(
      host.querySelector<HTMLSelectElement>('select[aria-label="State"]')!
        .value,
    ).toBe('');
  });

  test('adding after a cancelled repair starts clean and creates a new row', async () => {
    await render(
      [item('pull_a', 'pack', 100)],
      [{ ...ADDRESS, countryCode: '60' } as AddressView],
    );
    await act(async () => button('Fix this address')!.click());
    await act(async () => button('Cancel')!.click());
    await act(async () => button('+ Add a new address')!.click());

    const address = host.querySelector<HTMLInputElement>(
      'input[aria-label="Address"]',
    )!;
    expect(address.value).toBe('');
    expect(
      host.querySelector<HTMLSelectElement>('select[aria-label="Country"]')!
        .value,
    ).toBe('MY');

    mocks.addAddress.mockResolvedValueOnce({ ok: true, addressId: 'addr_2' });
    await act(async () => button('Save address')!.click());
    expect(mocks.addAddress).toHaveBeenCalled();
    expect(mocks.updateAddress).not.toHaveBeenCalled();
  });

  // This sheet is not a real <form>, so the select's `required` does nothing.
  test('Save stays disabled on a repair until a country is picked', async () => {
    await render(
      [item('pull_a', 'pack', 100)],
      [{ ...ADDRESS, countryCode: '60' } as AddressView],
    );
    await act(async () => button('Fix this address')!.click());
    expect(button('Save address')!.disabled).toBe(true);

    const country = host.querySelector<HTMLSelectElement>(
      'select[aria-label="Country"]',
    )!;
    await act(async () => {
      country.value = 'MY';
      country.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(button('Save address')!.disabled).toBe(false);
  });

  test('a new address can be saved straight away: it defaults to Malaysia', async () => {
    await render([item('pull_a', 'pack', 100)], []);
    expect(button('Save address')!.disabled).toBe(false);
  });

  // A saved row with a real country and a postcode that cannot be zoned: the
  // submit is disabled, so without a way in the customer is stuck here.
  test('offers Fix on a bad postcode, keeping the saved country', async () => {
    await render(
      [item('pull_a', 'pack', 100)],
      [
        {
          ...ADDRESS,
          province: 'Selangor',
          postalCode: '5000',
        } as AddressView,
      ],
    );
    expect(host.textContent).toContain(
      'That address needs a valid 5-digit Malaysian postcode',
    );
    expect(button('Request delivery')!.disabled).toBe(true);

    await act(async () => button('Fix this address')!.click());
    const select = (label: string) =>
      host.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
    expect(select('Country').value).toBe('MY');
    expect(select('State').value).toBe('Selangor');
    expect(button('Save address')!.disabled).toBe(false);

    const postcode = host.querySelector<HTMLInputElement>(
      'input[aria-label="Postal code"]',
    )!;
    expect(postcode.value).toBe('5000');
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!.call(postcode, '50000');
      postcode.dispatchEvent(new Event('input', { bubbles: true }));
    });
    mocks.updateAddress.mockResolvedValueOnce({ ok: true });
    await act(async () => button('Save address')!.click());
    expect(mocks.updateAddress).toHaveBeenCalledWith(
      'addr_1',
      expect.objectContaining({ countryCode: 'MY', postalCode: '50000' }),
    );
    expect(host.querySelectorAll('input[name="addr"]')).toHaveLength(1);
    expect(host.textContent).not.toContain('That address needs');
    expect(button('Request delivery')!.disabled).toBe(false);
  });

  test('a Malaysian who misclicked Singapore can switch back from Fix', async () => {
    await render(
      [item('pull_a', 'pack', 100)],
      [
        {
          ...ADDRESS,
          countryCode: 'SG',
          province: 'Singapore',
          postalCode: '50000',
        } as AddressView,
      ],
    );
    expect(host.textContent).toContain(
      'That address needs a valid 6-digit Singapore postcode',
    );
    await act(async () => button('Fix this address')!.click());
    const country = host.querySelector<HTMLSelectElement>(
      'select[aria-label="Country"]',
    )!;
    expect(country.value).toBe('SG');
    await act(async () => {
      country.value = 'MY';
      country.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(
      host.querySelector<HTMLSelectElement>('select[aria-label="State"]')!
        .value,
    ).toBe('');
  });
});

describe('RequestDeliveryModal review fixes', () => {
  test('bonus credit pays shipping: a bonus-heavy balance still ships', async () => {
    mocks.balance = 80;
    mocks.bonus = 60;
    await render([item('pull_a', 'pack', 100)], [SG_ADDRESS]);
    expect(host.textContent).not.toContain('Not enough balance');
    expect(button('Request delivery')!.disabled).toBe(false);
  });

  test('a balance under the fee, bonus included, is sent to top up', async () => {
    mocks.balance = 40;
    mocks.bonus = 30;
    await render([item('pull_a', 'pack', 100)], [SG_ADDRESS]);
    expect(host.textContent).toContain('Top up RM 10.00 or more');
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
    // One parcel: RM15 shipping once, the held-back prize unpriced.
    expect(text).toContain('RM 15.00');
    expect(text).toContain('Prize cards ship 1 per day');
    await act(async () => button('Request delivery')!.click());
    await act(async () => button('Confirm & pay RM 15.00')!.click());
    expect(mocks.shipVaultCards).toHaveBeenCalledWith(
      ['pull_a'],
      ['pull_r1'],
      'addr_1',
    );
  });

  test('insures a prize worth over RM200', async () => {
    await render([item('pull_r', 'reward', 400)]);
    const text = host.textContent ?? '';
    expect(text).toContain('Insurance (5% of card value)');
    // RM15 shipping + RM20 insurance.
    expect(text).toContain('RM 35.00');
  });

  test('a top-up made while the sheet is open clears the shortfall', async () => {
    mocks.balance = 20;
    await render([item('pull_a', 'pack', 100)], [SG_ADDRESS]);
    expect(button('Request delivery')!.disabled).toBe(true);
    // The header balance moves (TopUpProvider applies the new figure); the
    // wallet read from open time is not repeated.
    mocks.balance = 100;
    await render([item('pull_a', 'pack', 100)], [SG_ADDRESS]);
    expect(host.textContent).not.toContain('Not enough balance');
    expect(button('Request delivery')!.disabled).toBe(false);
  });

  test('closing the sheet drops a pending confirmation', async () => {
    await render([item('pull_a', 'pack', 100)]);
    await act(async () => button('Request delivery')!.click());
    expect(button(/^Confirm & pay/)).toBeDefined();
    await act(async () =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })),
    );
    await render([item('pull_a', 'pack', 100)], [ADDRESS], false);
    await render([item('pull_a', 'pack', 100)]);
    expect(button(/^Confirm & pay/)).toBeUndefined();
    expect(button('Request delivery')).toBeDefined();
  });

  test('no fee box when no selected prize can ship today', async () => {
    mocks.allowance = { perDay: 1, remaining: 0 };
    await render([item('pull_r', 'reward', 10)]);
    const text = host.textContent ?? '';
    expect(text).not.toContain('Total — deducted from balance');
    expect(text).toContain('Prize cards ship 1 per day');
    expect(button('Request delivery')!.disabled).toBe(true);
  });

  test('adding a new address drops a pending confirmation', async () => {
    await render([item('pull_a', 'pack', 100)]);
    await act(async () => button('Request delivery')!.click());
    expect(button(/^Confirm & pay/)).toBeDefined();
    await act(async () => button('+ Add a new address')!.click());
    expect(button(/^Confirm & pay/)).toBeUndefined();
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { storeShim } from '@/lib/__tests__/store-shim';

// The address-book actions still go through the SDK (built-in Medusa endpoints
// with typed responses), so this file keeps its sdk/customer mocks. The port's
// HTTP adapter imports 'server-only' and is pulled in by the file's OTHER
// actions, so it is shimmed too — nothing here reaches it.
vi.mock('@/lib/store', () => ({ store: storeShim }));
const mocks = vi.hoisted(() => ({
  getAuthToken: vi.fn(),
  getCustomerSession: vi.fn(),
  createAddress: vi.fn(),
  updateAddress: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('@/lib/data/customer', () => ({
  getAuthToken: mocks.getAuthToken,
  getCustomer: vi.fn(),
  getCustomerSession: mocks.getCustomerSession,
}));
vi.mock('@/lib/logger', () => ({
  logger: {
    error: mocks.logError,
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));
vi.mock('@/lib/medusa', () => ({
  sdk: {
    store: {
      customer: {
        createAddress: mocks.createAddress,
        updateAddress: mocks.updateAddress,
      },
    },
  },
}));

import { addAddress, updateAddress, type AddAddressInput } from '../delivery';

// `province` is REQUIRED for MY (missingRequired) and is carried here so the
// phone-validation cases below keep testing the phone. Without it they would
// short-circuit on the province gate and silently become a second, weaker copy
// of the province tests at the bottom of this file.
const BASE_INPUT: AddAddressInput = {
  firstName: 'Test',
  lastName: 'User',
  address1: '123 Jalan Test',
  city: 'Kuala Lumpur',
  province: 'W.P. Kuala Lumpur',
  postalCode: '50000',
  countryCode: 'MY',
};

const PHONE_ERROR =
  'Please enter a valid phone number for the selected country.';

beforeEach(() => {
  vi.clearAllMocks();
  // A truthy token by default — every case here targets the phone-validation
  // branch, which sits AFTER the auth check. Without this every assertion
  // would pass vacuously against `{ ok: false, needsAuth: true }`.
  mocks.getAuthToken.mockResolvedValue('test-token');
  mocks.getCustomerSession.mockResolvedValue({
    customer: { addresses: [] },
    stale: false,
  });
});

// Plan 064: the address book is the actual SOURCE of a delivery order's
// ship_phone, and the backend's profile-phone fallback only fires when it's
// BLANK — so a garbage address phone must be rejected here exactly like the
// profile phone (customer.ts), not silently stored and suppress the fallback.
describe('addAddress — phone validation', () => {
  it('normalizes a MY-format local number to E.164', async () => {
    mocks.createAddress.mockResolvedValueOnce({
      customer: { addresses: [{ id: 'addr_1' }] },
    });

    const r = await addAddress({ ...BASE_INPUT, phone: '012-345 6789' });

    expect(r).toEqual({ ok: true, addressId: 'addr_1' });
    const [body] = mocks.createAddress.mock.calls[0]!;
    expect(body.phone).toBe('+60123456789');
  });

  it('rejects a garbage phone with the same copy as the profile phone', async () => {
    const r = await addAddress({ ...BASE_INPUT, phone: 'call me maybe' });

    expect(r).toEqual({ ok: false, error: PHONE_ERROR });
    expect(mocks.createAddress).not.toHaveBeenCalled();
  });

  it('treats an empty phone as optional (stored null)', async () => {
    mocks.createAddress.mockResolvedValueOnce({
      customer: { addresses: [{ id: 'addr_2' }] },
    });

    const r = await addAddress({ ...BASE_INPUT, phone: '' });

    expect(r).toEqual({ ok: true, addressId: 'addr_2' });
    const [body] = mocks.createAddress.mock.calls[0]!;
    expect(body.phone).toBeNull();
  });
});

describe('updateAddress — phone validation', () => {
  it('rejects a garbage phone on update with the same copy', async () => {
    const r = await updateAddress('addr_1', {
      ...BASE_INPUT,
      phone: 'nope nope',
    });

    expect(r).toEqual({ ok: false, error: PHONE_ERROR });
    expect(mocks.updateAddress).not.toHaveBeenCalled();
  });
});

// Plan 126: the state picks the shipping zone (delivery-fee.ts), so a MY
// address without one gets billed the West rate whenever its town is outside
// the 12-name city allowlist. The gate is MY-scoped on purpose — it is shared
// with updateAddress, and an unconditional rule would make every pre-existing
// non-MY address uneditable.
describe('addAddress — province is required for MY only', () => {
  it('rejects a MY address with no province', async () => {
    const { province: _province, ...noProvince } = BASE_INPUT;

    const r = await addAddress(noProvince);

    expect(r).toEqual({
      ok: false,
      error: 'Fill in the required address fields.',
    });
    expect(mocks.createAddress).not.toHaveBeenCalled();
  });

  it('accepts a non-MY address with no province', async () => {
    mocks.createAddress.mockResolvedValueOnce({
      customer: { addresses: [{ id: 'addr_sg' }] },
    });
    const { province: _province, ...noProvince } = BASE_INPUT;

    const r = await addAddress({
      ...noProvince,
      city: 'Singapore',
      postalCode: '188065',
      countryCode: 'SG',
    });

    expect(r).toEqual({ ok: true, addressId: 'addr_sg' });
    expect(mocks.createAddress).toHaveBeenCalled();
  });
});

// 2026-10-20: the forms took the country as free text, and 74 Malaysian
// addresses were saved as "60", "+6", "MALAYSIA", "MA", "MYS" or an area code.
// Nothing ships to those, so the delivery modal refused every one of them.
describe('addAddress / updateAddress — country must be MY or SG', () => {
  const COUNTRY_ERROR = 'Choose Malaysia or Singapore as the country.';

  it.each(['60', '+6', 'MALAYSIA', 'MA', 'MYS', '03', 'GB'])(
    'refuses %s before saving',
    async (countryCode) => {
      const r = await addAddress({ ...BASE_INPUT, countryCode });

      expect(r).toEqual({ ok: false, error: COUNTRY_ERROR });
      expect(mocks.createAddress).not.toHaveBeenCalled();
    },
  );

  it('refuses it on update too', async () => {
    const r = await updateAddress('addr_1', {
      ...BASE_INPUT,
      countryCode: '60',
    });

    expect(r).toEqual({ ok: false, error: COUNTRY_ERROR });
    expect(mocks.updateAddress).not.toHaveBeenCalled();
  });

  it('stores a lowercase or padded code as the canonical upper case', async () => {
    mocks.createAddress.mockResolvedValueOnce({
      customer: { addresses: [{ id: 'addr_my' }] },
    });

    const r = await addAddress({ ...BASE_INPUT, countryCode: ' my ' });

    expect(r).toEqual({ ok: true, addressId: 'addr_my' });
    const [body] = mocks.createAddress.mock.calls[0]!;
    expect(body.country_code).toBe('MY');
  });
});

// The delivery request refuses these (backend snapshotAddress, isShippablePostcode).
// Saved anyway, the row looks fine in the book and the customer only meets the
// refusal at Confirm, so they are refused here, on both write paths.
describe.each([
  [
    'addAddress',
    (input: AddAddressInput) => addAddress(input),
    mocks.createAddress,
  ],
  [
    'updateAddress',
    (input: AddAddressInput) => updateAddress('addr_1', input),
    mocks.updateAddress,
  ],
] as const)('%s — refuses what a delivery would refuse', (_name, save, sdk) => {
  it.each([
    ['blank', '', ''],
    ['whitespace', '  ', ' '],
  ])(
    'refuses a %s first and last name',
    async (_label, firstName, lastName) => {
      expect(await save({ ...BASE_INPUT, firstName, lastName })).toEqual({
        ok: false,
        error: 'Fill in the required address fields.',
      });
      expect(sdk).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['MY', '5000', 'a valid 5-digit Malaysian postcode'],
    ['MY', '018983', 'a valid 5-digit Malaysian postcode'],
    ['MY', 'ABCDE', 'a valid 5-digit Malaysian postcode'],
    ['SG', '50000', 'a valid 6-digit Singapore postcode'],
  ])('refuses %s with postcode %s', async (countryCode, postalCode, hint) => {
    expect(await save({ ...BASE_INPUT, countryCode, postalCode })).toEqual({
      ok: false,
      error: `Enter ${hint} for this address.`,
    });
    expect(sdk).not.toHaveBeenCalled();
  });

  it('keeps a stored MY row with a valid postcode saving unchanged', async () => {
    sdk.mockResolvedValueOnce({ customer: { addresses: [{ id: 'addr_1' }] } });

    expect((await save(BASE_INPUT)).ok).toBe(true);

    const body = sdk.mock.calls[0]!.find(
      (arg: unknown) => (arg as { address_1?: string })?.address_1,
    );
    expect(body).toEqual({
      first_name: 'Test',
      last_name: 'User',
      address_1: '123 Jalan Test',
      address_2: null,
      city: 'Kuala Lumpur',
      province: 'W.P. Kuala Lumpur',
      postal_code: '50000',
      country_code: 'MY',
      phone: null,
    });
  });

  it('accepts a Singapore 6-digit postcode', async () => {
    sdk.mockResolvedValueOnce({ customer: { addresses: [{ id: 'addr_1' }] } });

    const r = await save({
      ...BASE_INPUT,
      city: 'Singapore',
      province: 'Singapore',
      postalCode: '018983',
      countryCode: 'SG',
    });

    expect(r.ok).toBe(true);
  });

  it('accepts a row with only one of the two names', async () => {
    sdk.mockResolvedValueOnce({ customer: { addresses: [{ id: 'addr_1' }] } });

    expect((await save({ ...BASE_INPUT, lastName: '' })).ok).toBe(true);
  });
});

// Medusa's store route refetches the customer with no order on `addresses`, so
// the list comes back in whatever order Postgres reads it. The id returned here
// is what the parcel ships to, so it must be the new row wherever it sits.
describe('addAddress — which row is new', () => {
  it('picks the new row by id, not by its place in the list', async () => {
    mocks.getCustomerSession.mockResolvedValueOnce({
      customer: { addresses: [{ id: 'addr_a' }, { id: 'addr_b' }] },
      stale: false,
    });
    mocks.createAddress.mockResolvedValueOnce({
      customer: {
        addresses: [{ id: 'addr_new' }, { id: 'addr_b' }, { id: 'addr_a' }],
      },
    });

    expect(await addAddress(BASE_INPUT)).toEqual({
      ok: true,
      addressId: 'addr_new',
    });
  });

  it('saves nothing when the book cannot be read first', async () => {
    mocks.getCustomerSession.mockResolvedValueOnce({
      customer: null,
      stale: false,
    });

    expect(await addAddress(BASE_INPUT)).toEqual({
      ok: false,
      error: 'Address was not saved. Please try again.',
      needsAuth: false,
    });
    expect(mocks.createAddress).not.toHaveBeenCalled();
  });

  it('asks for a login when the session expired', async () => {
    mocks.getCustomerSession.mockResolvedValueOnce({
      customer: null,
      stale: true,
    });

    expect(await addAddress(BASE_INPUT)).toEqual({
      ok: false,
      error: 'Please log in first.',
      needsAuth: true,
    });
    expect(mocks.createAddress).not.toHaveBeenCalled();
  });

  it('reports not saved when no row in the answer is new', async () => {
    mocks.getCustomerSession.mockResolvedValueOnce({
      customer: { addresses: [{ id: 'addr_a' }] },
      stale: false,
    });
    mocks.createAddress.mockResolvedValueOnce({
      customer: { addresses: [{ id: 'addr_a' }] },
    });

    expect(await addAddress(BASE_INPUT)).toEqual({
      ok: false,
      error: 'Address was not saved. Please try again.',
    });
  });
});

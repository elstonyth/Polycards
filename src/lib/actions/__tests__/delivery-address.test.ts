import { describe, it, expect, vi, beforeEach } from 'vitest';

// The real data modules import 'server-only' (throws outside an RSC) and touch
// next/headers — mock them wholesale so only the action logic under test runs,
// same harness shape as auth.test.ts.
const mocks = vi.hoisted(() => ({
  getAuthToken: vi.fn(),
  createAddress: vi.fn(),
  updateAddress: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('@/lib/data/customer', () => ({
  getAuthToken: mocks.getAuthToken,
  getCustomer: vi.fn(),
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

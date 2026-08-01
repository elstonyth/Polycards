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

const BASE_INPUT: AddAddressInput = {
  firstName: 'Test',
  lastName: 'User',
  address1: '123 Jalan Test',
  city: 'Kuala Lumpur',
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

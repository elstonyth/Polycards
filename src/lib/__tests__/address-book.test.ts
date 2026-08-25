import { describe, it, expect, vi, beforeEach } from 'vitest';

// Unit-test the address-book server actions (add / update / delete) at the
// boundary that unit tests can actually see: what SHAPE reaches the Medusa SDK.
//
// The load-bearing case is a CLEARED optional field. `JSON.stringify` drops an
// `undefined` value, and the store update route is a PARTIAL write — so a key
// that never reaches the wire leaves the stored value untouched while the UI
// optimistically renders it blank. That is a silent write failure the type
// checker cannot see, which is exactly why it is pinned here.
const { createMock, updateMock, deleteMock, getAuthTokenMock } = vi.hoisted(
  () => ({
    createMock: vi.fn(),
    updateMock: vi.fn(),
    deleteMock: vi.fn(),
    getAuthTokenMock: vi.fn(),
  }),
);

vi.mock('@/lib/medusa', () => ({
  sdk: {
    client: { fetch: vi.fn() },
    store: {
      customer: {
        createAddress: createMock,
        updateAddress: updateMock,
        deleteAddress: deleteMock,
      },
    },
  },
}));
vi.mock('@/lib/data/customer', () => ({
  getAuthToken: getAuthTokenMock,
  getCustomer: vi.fn(),
}));
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import {
  addAddress,
  updateAddress,
  deleteAddress,
  type AddAddressInput,
} from '@/lib/actions/delivery';

const FULL: AddAddressInput = {
  firstName: 'Wei',
  lastName: 'Lim',
  address1: '2 Jalan Ekoflora 2/12',
  address2: 'Taman Ekoflora',
  city: 'Johor Bahru',
  province: 'Johor',
  postalCode: '81100',
  countryCode: 'MY',
  phone: '+60123456789',
};

beforeEach(() => {
  createMock.mockReset();
  updateMock.mockReset();
  deleteMock.mockReset();
  getAuthTokenMock.mockReset();
  getAuthTokenMock.mockResolvedValue('tok');
  createMock.mockResolvedValue({ customer: { addresses: [{ id: 'addr_1' }] } });
  updateMock.mockResolvedValue({ customer: { addresses: [] } });
  deleteMock.mockResolvedValue({ deleted: true });
});

describe('addAddress', () => {
  it('maps the camelCase form to the snake_case SDK body', async () => {
    const res = await addAddress(FULL);
    expect(res).toEqual({ ok: true, addressId: 'addr_1' });
    expect(createMock.mock.calls[0]?.[0]).toEqual({
      first_name: 'Wei',
      last_name: 'Lim',
      address_1: '2 Jalan Ekoflora 2/12',
      address_2: 'Taman Ekoflora',
      city: 'Johor Bahru',
      province: 'Johor',
      postal_code: '81100',
      country_code: 'MY',
      phone: '+60123456789',
    });
  });

  it('refuses a body missing a field a parcel cannot ship without', async () => {
    const res = await addAddress({ ...FULL, city: '   ' });
    expect(res).toEqual({
      ok: false,
      error: 'Fill in the required address fields.',
    });
    expect(createMock).not.toHaveBeenCalled();
  });
});

describe('updateAddress', () => {
  it('sends the address id, the body, and the bearer token', async () => {
    const res = await updateAddress('addr_1', FULL);
    expect(res).toEqual({ ok: true });
    const [id, body, , headers] = updateMock.mock.calls[0] ?? [];
    expect(id).toBe('addr_1');
    expect(body).toMatchObject({ address_1: '2 Jalan Ekoflora 2/12' });
    expect(headers).toEqual({ Authorization: 'Bearer tok' });
  });

  // THE regression case. With `|| undefined` these keys vanished from the JSON
  // body, the partial update kept the old values, and the caller still got
  // `{ ok: true }` — the row read as cleared until the next reload.
  it('sends null (not undefined) for CLEARED optional fields, so the partial update actually erases them', async () => {
    await updateAddress('addr_1', {
      ...FULL,
      // Non-MY on purpose: since plan 126 the province is REQUIRED for MY, so
      // a blank one on a MY address is rejected before it reaches the SDK and
      // this case could never exercise the null mapping. Off-MY it is still a
      // genuine optional field, which is what this test is about.
      countryCode: 'SG',
      address2: '',
      province: '',
      phone: '',
    });
    const body = updateMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.address_2).toBeNull();
    expect(body.province).toBeNull();
    expect(body.phone).toBeNull();
    // Survives serialization — `undefined` would not.
    const wire = JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
    expect(wire).toHaveProperty('address_2', null);
    expect(wire).toHaveProperty('province', null);
    expect(wire).toHaveProperty('phone', null);
  });

  it('applies the same required-field gate as add', async () => {
    const res = await updateAddress('addr_1', { ...FULL, address1: '' });
    expect(res).toEqual({
      ok: false,
      error: 'Fill in the required address fields.',
    });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('rejects a blank address id without hitting the backend', async () => {
    expect(await updateAddress('  ', FULL)).toEqual({
      ok: false,
      error: 'Missing address.',
    });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('surfaces a friendly error and the auth flag when the SDK throws 401', async () => {
    updateMock.mockRejectedValue(new Error('Unauthorized'));
    const res = await updateAddress('addr_1', FULL);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.needsAuth).toBe(true);
  });
});

describe('deleteAddress', () => {
  it('sends the id and the bearer token', async () => {
    expect(await deleteAddress('addr_1')).toEqual({ ok: true });
    expect(deleteMock).toHaveBeenCalledWith('addr_1', {
      Authorization: 'Bearer tok',
    });
  });

  it('rejects a blank id without hitting the backend — a destructive call must never fire on a guessed target', async () => {
    expect(await deleteAddress('')).toEqual({
      ok: false,
      error: 'Missing address.',
    });
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('asks for login when there is no auth token', async () => {
    getAuthTokenMock.mockResolvedValue(null);
    const res = await deleteAddress('addr_1');
    expect(res).toEqual({
      ok: false,
      error: 'Please log in first.',
      needsAuth: true,
    });
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('reports a failure instead of pretending the row is gone', async () => {
    deleteMock.mockRejectedValue(new Error('not found'));
    const res = await deleteAddress('addr_1');
    expect(res.ok).toBe(false);
  });
});

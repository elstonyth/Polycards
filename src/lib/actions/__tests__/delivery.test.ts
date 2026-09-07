import { describe, it, expect, vi } from 'vitest';
import { storeShim, backend } from '@/lib/__tests__/store-shim';
import type { WithdrawAddressInput } from '@/lib/data/schemas';

// The five migrated actions import the port's HTTP adapter; point that import
// at an in-memory backend per test (src/lib/__tests__/store-shim.ts). The
// address-book actions still go through the SDK and keep their own mocks — see
// delivery-address.test.ts.
vi.mock('@/lib/store', () => ({ store: storeShim }));
vi.mock('@/lib/data/customer', () => ({
  getAuthToken: vi.fn(),
  getCustomer: vi.fn(),
}));
vi.mock('@/lib/medusa', () => ({ sdk: { store: { customer: {} } } }));

import {
  getDeliveryOrders,
  requestDelivery,
  editDeliveryAddress,
  cancelDeliveryOrder,
  shipVaultCards,
} from '../delivery';

const ORDER = {
  id: 'do_1',
  status: 'requested',
  tracking_number: null,
  created_at: '2026-09-01T00:00:00.000Z',
  shipping_fee: 20,
  insurance_fee: 5,
  proof_images: [],
  address: {
    name: 'Test User',
    address_1: '123 Jalan Test',
    city: 'Kuala Lumpur',
    postal_code: '50000',
    country_code: 'MY',
  },
  items: [
    {
      pull_id: 'pull_1',
      card: { handle: 'pikachu', name: 'Pikachu', image: 'i.png' },
    },
  ],
};

const ADDRESS: WithdrawAddressInput = {
  firstName: 'Test',
  lastName: 'User',
  address1: '123 Jalan Test',
  city: 'Kuala Lumpur',
  postalCode: '50000',
  countryCode: 'MY',
};

describe('getDeliveryOrders', () => {
  it('maps the order list to the view shape', async () => {
    const mem = backend({
      'GET /store/delivery-orders': { body: { items: [ORDER] } },
    });
    const r = await getDeliveryOrders();
    expect(r.ok && r.orders[0]).toMatchObject({
      id: 'do_1',
      status: 'requested',
      shippingFee: 20,
      insuranceFee: 5,
      address: { line1: '123 Jalan Test', province: null },
      items: [{ pullId: 'pull_1', card: { slabImage: null } }],
    });
    expect(mem.requests).toEqual([
      {
        method: 'GET',
        path: '/store/delivery-orders',
        headers: { Authorization: 'Bearer test-token' },
        cache: 'no-store',
      },
    ]);
  });

  // A row this build cannot parse drops; the rest of the customer's history
  // still renders.
  it('drops an unparsable row instead of blanking the history', async () => {
    backend({
      'GET /store/delivery-orders': {
        body: { items: [ORDER, { id: 'broken' }] },
      },
    });
    const r = await getDeliveryOrders();
    expect(r.ok && r.orders.map((o) => o.id)).toEqual(['do_1']);
  });

  it('logged out: asks for a login without calling the backend', async () => {
    const mem = backend({}, { token: null });
    expect(await getDeliveryOrders()).toEqual({
      ok: false,
      error: 'Please log in to view your orders.',
      needsAuth: true,
    });
    expect(mem.requests).toEqual([]);
  });
});

describe('requestDelivery', () => {
  it('posts the selection and the address id', async () => {
    const mem = backend({
      'POST /store/delivery-orders': { body: { order_id: 'do_1' } },
    });
    expect(await requestDelivery(['pull_1', 'pull_2'], 'addr_1')).toEqual({
      ok: true,
      orderId: 'do_1',
    });
    expect(mem.requests).toEqual([
      {
        method: 'POST',
        path: '/store/delivery-orders',
        headers: { Authorization: 'Bearer test-token' },
        cache: 'no-store',
        body: { pull_ids: ['pull_1', 'pull_2'], address_id: 'addr_1' },
      },
    ]);
  });

  it.each([
    [[], 'addr_1', 'Select at least one card.'],
    [['pull_1'], '  ', 'Choose a shipping address.'],
  ])('refuses %o / %p before any request', async (pulls, addr, error) => {
    const mem = backend({});
    expect(await requestDelivery(pulls, addr)).toEqual({ ok: false, error });
    expect(mem.requests).toEqual([]);
  });

  // The fee refusals must not flatten into the generic "check your selection"
  // rule that sits below them.
  it('surfaces the shipping-fee balance refusal', async () => {
    backend({
      'POST /store/delivery-orders': {
        status: 400,
        body: { message: "Fee exceeds the customer's balance." },
      },
    });
    expect(await requestDelivery(['pull_1'], 'addr_1')).toEqual({
      ok: false,
      error:
        'Not enough credit to cover the shipping fee — top up and try again.',
      needsAuth: false,
    });
  });

  it('a 2xx without an order id keeps its own copy', async () => {
    backend({ 'POST /store/delivery-orders': { body: {} } });
    expect(await requestDelivery(['pull_1'], 'addr_1')).toEqual({
      ok: false,
      error: 'Got an unexpected response. Please try again.',
    });
  });
});

describe('editDeliveryAddress', () => {
  it('re-points the order at another saved address', async () => {
    const mem = backend({
      'POST /store/delivery-orders/:id/address': { body: {} },
    });
    expect(await editDeliveryAddress('do_1', 'addr_2')).toEqual({ ok: true });
    expect(mem.requests[0]).toMatchObject({
      method: 'POST',
      path: '/store/delivery-orders/do_1/address',
      body: { address_id: 'addr_2' },
    });
  });

  it('surfaces the zone-change refusal rather than a generic one', async () => {
    backend({
      'POST /store/delivery-orders/:id/address': {
        status: 400,
        body: { message: 'That address changes the shipping fee zone.' },
      },
    });
    expect(await editDeliveryAddress('do_1', 'addr_2')).toMatchObject({
      ok: false,
      error:
        'That address changes the shipping fee zone — cancel this delivery (the fee is refunded) and request it again with the new address.',
    });
  });
});

describe('cancelDeliveryOrder', () => {
  it('cancels with no body and reports the new status', async () => {
    const mem = backend({
      'POST /store/delivery-orders/:id/cancel': {
        body: { order: { ...ORDER, status: 'canceled' } },
      },
    });
    expect(await cancelDeliveryOrder('do_1')).toEqual({
      ok: true,
      status: 'canceled',
    });
    expect(mem.requests).toEqual([
      {
        method: 'POST',
        path: '/store/delivery-orders/do_1/cancel',
        headers: { Authorization: 'Bearer test-token' },
        cache: 'no-store',
      },
    ]);
  });

  // A 2xx MEANS the cancel happened — the cards are back in the vault — so a
  // body this build cannot read must not turn into a failure.
  it.each([
    ['a drifted order block', { order: { id: 'do_1' } }],
    ['no order block at all', {}],
    ['a body that is not an object', 'ok'],
  ])('falls back to canceled on %s', async (_label, body) => {
    backend({ 'POST /store/delivery-orders/:id/cancel': { body } });
    expect(await cancelDeliveryOrder('do_1')).toEqual({
      ok: true,
      status: 'canceled',
    });
  });

  // CANCEL_RULES, not DELIVERY_RULES: the generic table maps 409 to
  // request-delivery copy that would mislead here.
  it('uses the cancel vocabulary for a refusal', async () => {
    backend({
      'POST /store/delivery-orders/:id/cancel': {
        status: 409,
        body: { message: 'This order can no longer be canceled.' },
      },
    });
    expect(await cancelDeliveryOrder('do_1')).toEqual({
      ok: false,
      error:
        'This order is already being prepared for shipping and can no longer be canceled — please contact support.',
      needsAuth: false,
    });
  });
});

describe('shipVaultCards', () => {
  it('ships reward pulls ONE AT A TIME, since the cap is per request', async () => {
    const mem = backend({
      'POST /store/rewards/withdraw': { body: { status: 'requested' } },
    });
    expect(
      await shipVaultCards([], ['pull_1', 'pull_2'], 'addr_1', ADDRESS),
    ).toEqual({ ok: true, shippedIds: ['pull_1', 'pull_2'], skipped: [] });
    expect(mem.requests.map((r) => [r.path, r.body])).toEqual([
      ['/store/rewards/withdraw', { pull_id: 'pull_1', address: ADDRESS }],
      ['/store/rewards/withdraw', { pull_id: 'pull_2', address: ADDRESS }],
    ]);
  });

  it('routes ordinary and reward pulls to their own backends', async () => {
    const mem = backend({
      'POST /store/delivery-orders': { body: { order_id: 'do_1' } },
      'POST /store/rewards/withdraw': { body: { status: 'requested' } },
    });
    const r = await shipVaultCards(['pull_a'], ['pull_r'], 'addr_1', ADDRESS);
    expect(r).toEqual({
      ok: true,
      shippedIds: ['pull_a', 'pull_r'],
      skipped: [],
    });
    expect(mem.requests.map((x) => x.path)).toEqual([
      '/store/delivery-orders',
      '/store/rewards/withdraw',
    ]);
  });

  // A partial outcome is normal (the cap is reached mid-selection) and is
  // reported per card — the ordinary cards have already shipped by then.
  it('reports a per-card cap without failing the submit', async () => {
    let n = 0;
    backend({
      'POST /store/rewards/withdraw': () => ({
        body: { status: n++ === 0 ? 'requested' : 'capped' },
      }),
    });
    expect(
      await shipVaultCards([], ['pull_1', 'pull_2'], 'addr_1', ADDRESS),
    ).toEqual({
      ok: true,
      shippedIds: ['pull_1'],
      skipped: [
        {
          pullId: 'pull_2',
          reason: "You've hit today's reward shipping limit — try tomorrow.",
        },
      ],
    });
  });

  it('a per-card refusal becomes that card’s reason, not the whole submit’s', async () => {
    backend({
      'POST /store/rewards/withdraw': {
        status: 404,
        body: { message: 'Pull not found.' },
      },
    });
    expect(await shipVaultCards([], ['pull_1'], 'addr_1', ADDRESS)).toEqual({
      ok: true,
      shippedIds: [],
      skipped: [
        { pullId: 'pull_1', reason: 'That card or address was not found.' },
      ],
    });
  });

  // Logged out is the whole selection's problem, not one card's — and it must
  // land before anything is added to `skipped`.
  it('logged out fails the whole submit rather than skipping every card', async () => {
    const mem = backend({}, { token: null });
    expect(
      await shipVaultCards([], ['pull_1', 'pull_2'], 'addr_1', ADDRESS),
    ).toEqual({ ok: false, error: 'Please log in first.', needsAuth: true });
    expect(mem.requests).toEqual([]);
  });

  it('refuses an empty selection before anything', async () => {
    const mem = backend({});
    expect(await shipVaultCards([], [], 'addr_1', ADDRESS)).toEqual({
      ok: false,
      error: 'Select at least one card.',
    });
    expect(mem.requests).toEqual([]);
  });

  it('skips every reward card when the address is not shippable', async () => {
    const mem = backend({});
    const bad = { ...ADDRESS, postalCode: '' };
    expect(await shipVaultCards([], ['pull_1'], 'addr_1', bad)).toEqual({
      ok: true,
      shippedIds: [],
      skipped: [
        {
          pullId: 'pull_1',
          reason: 'That address is missing fields reward shipping requires.',
        },
      ],
    });
    expect(mem.requests).toEqual([]);
  });
});

it('contains a null delivery response with the original fallback fields', async () => {
  backend({ 'POST /store/delivery-orders': { body: null } });
  await expect(requestDelivery(['pull_1'], 'addr_1')).resolves.toEqual({
    ok: false,
    error: 'Something went wrong. Please try again.',
    needsAuth: false,
  });
});

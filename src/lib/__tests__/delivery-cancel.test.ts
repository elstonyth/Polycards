import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  storeShim,
  backend as memoryBackend,
} from '@/lib/__tests__/store-shim';
import type { MemoryRoutes } from '@/lib/store-memory';

// Unit-test the cancelDeliveryOrder server action's mapping: boundary
// validation, auth gating, the success-response parse, and the cancel-specific
// error vocabulary (already-shipped → "contact support", mirroring the backend
// copy from POST /store/delivery-orders/:id/cancel).
//
// Both actions go through the `Store` port; point that import at an in-memory
// backend per test. `@/lib/data/customer` still needs a stub — the file's
// address-book actions import it and it pulls in 'server-only'.
vi.mock('@/lib/store', () => ({ store: storeShim }));
vi.mock('@/lib/data/customer', () => ({
  getAuthToken: vi.fn(),
  getCustomer: vi.fn(),
}));
vi.mock('@/lib/medusa', () => ({ sdk: { store: { customer: {} } } }));

import { cancelDeliveryOrder, getDeliveryOrders } from '@/lib/actions/delivery';

const CANCEL = 'POST /store/delivery-orders/:id/cancel';
const LIST = 'GET /store/delivery-orders';

/** An unregistered route THROWS, so the default backend is also the assertion
 *  that a boundary check ran before anything left. */
let mem = memoryBackend({});
const backend = (routes: MemoryRoutes, opts?: { token?: string | null }) =>
  (mem = memoryBackend(routes, opts));
/** One route refusing with `message` — the text the copy tables match on. */
const refuses = (route: string, message: string, status = 400) =>
  backend({ [route]: { status, body: { message } } });

beforeEach(() => {
  backend({});
});

describe('cancelDeliveryOrder', () => {
  it('rejects a missing order id without hitting the backend', async () => {
    const res = await cancelDeliveryOrder('');
    expect(res).toEqual({ ok: false, error: 'Missing order.' });
    expect(mem.requests).toEqual([]);
  });

  it('asks for login when there is no auth token', async () => {
    backend({}, { token: null });
    const res = await cancelDeliveryOrder('do_1');
    expect(res).toEqual({
      ok: false,
      error: 'Please log in first.',
      needsAuth: true,
    });
    expect(mem.requests).toEqual([]);
  });

  it('POSTs to the cancel route and returns the backend status', async () => {
    backend({
      [CANCEL]: {
        body: {
          order: {
            id: 'do_1',
            status: 'canceled',
            created_at: '2026-07-11T00:00:00Z',
            tracking_number: null,
            items: [],
          },
        },
      },
    });
    const res = await cancelDeliveryOrder('do_1');
    expect(res).toEqual({ ok: true, status: 'canceled' });
    expect(mem.requests[0]).toMatchObject({
      method: 'POST',
      path: '/store/delivery-orders/do_1/cancel',
      headers: { Authorization: 'Bearer test-token' },
    });
  });

  it('still succeeds when the 2xx body is not the expected shape', async () => {
    // A 2xx means the cancel happened — a drifted body must not false-fail it.
    backend({ [CANCEL]: { body: { order: { unexpected: true } } } });
    const res = await cancelDeliveryOrder('do_1');
    expect(res).toEqual({ ok: true, status: 'canceled' });
  });

  // The customer window closes at `processed`, so the backend refuses from
  // `ready_to_ship` on — BEFORE the parcel physically ships. The copy has to be
  // true for every status it covers, hence "being prepared" rather than
  // "shipped": telling a customer their order shipped when it is still on the
  // packing bench is the kind of wrong that generates the support ticket it was
  // meant to pre-empt.
  it.each([
    'This delivery is already ready to ship and can no longer be canceled — please contact support.',
    'This delivery is already shipped and can no longer be canceled — please contact support.',
  ])(
    'maps the post-window refusal (%s) to the contact-support copy',
    async (message) => {
      refuses(CANCEL, message, 409);
      const res = await cancelDeliveryOrder('do_1');
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error).toBe(
          'This order is already being prepared for shipping and can no longer be canceled — please contact support.',
        );
        expect(res.needsAuth).toBe(false);
      }
    },
  );

  it('maps an already-canceled order to its own copy', async () => {
    refuses(CANCEL, 'This delivery is already canceled.', 409);
    const res = await cancelDeliveryOrder('do_1');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe('This delivery is already canceled.');
    }
  });

  it('maps 404 to a not-found message', async () => {
    refuses(CANCEL, 'Order not found.', 404);
    const res = await cancelDeliveryOrder('do_1');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe('That order was not found.');
    }
  });

  it('maps 401 to a login prompt with needsAuth', async () => {
    refuses(CANCEL, 'Unauthorized', 401);
    const res = await cancelDeliveryOrder('do_1');
    expect(res).toEqual({
      ok: false,
      error: 'Please log in to manage deliveries.',
      needsAuth: true,
    });
  });

  it('falls back to generic copy for an unknown error', async () => {
    refuses(CANCEL, 'ECONNRESET', 500);
    const res = await cancelDeliveryOrder('do_1');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe('Something went wrong. Please try again.');
    }
  });
});

// Deploy skew: the storefront ships independently of the backend (and can roll
// back), so an OLD backend still emits the pre-rename status names. `parseList`
// DROPS a row its schema rejects — a narrow enum makes the customer's order
// VANISH from /orders rather than read oddly, which tsc cannot see. These two
// cases are the runtime proof of DeliveryOrderSchema's transitional union, and
// they are what should go red when it is narrowed back to six next release.
describe('getDeliveryOrders during deploy skew', () => {
  const row = (status: string) => ({
    id: `do_${status}`,
    status,
    created_at: '2026-07-11T00:00:00Z',
    tracking_number: null,
    address: { name: 'Ada', city: 'London', country_code: 'gb' },
    items: [],
  });

  it('keeps rows carrying the old packing/delivered status names', async () => {
    backend({
      [LIST]: {
        body: {
          items: [
            row('packing'),
            row('processed'),
            row('delivered'),
            row('completed'),
          ],
        },
      },
    });
    const res = await getDeliveryOrders();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.orders.map((o) => o.status)).toEqual([
      'packing',
      'processed',
      'delivered',
      'completed',
    ]);
  });

  it('still drops a row whose status is no known token at all', async () => {
    // The widening is old ∪ new, not "anything goes".
    backend({
      [LIST]: { body: { items: [row('teleported'), row('shipped')] } },
    });
    const res = await getDeliveryOrders();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.orders.map((o) => o.status)).toEqual(['shipped']);
  });
});

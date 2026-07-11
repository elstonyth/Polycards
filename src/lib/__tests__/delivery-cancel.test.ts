import { describe, it, expect, vi, beforeEach } from 'vitest';

// Unit-test the cancelDeliveryOrder server action's mapping: boundary
// validation, auth gating, the success-response parse, and the cancel-specific
// error vocabulary (already-shipped → "contact support", mirroring the backend
// copy from POST /store/delivery-orders/:id/cancel).
const { fetchMock, getAuthTokenMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  getAuthTokenMock: vi.fn(),
}));

vi.mock('@/lib/medusa', () => ({ sdk: { client: { fetch: fetchMock } } }));
vi.mock('@/lib/data/customer', () => ({
  getAuthToken: getAuthTokenMock,
  getCustomer: vi.fn(),
}));
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { cancelDeliveryOrder } from '@/lib/actions/delivery';

beforeEach(() => {
  fetchMock.mockReset();
  getAuthTokenMock.mockReset();
  getAuthTokenMock.mockResolvedValue('tok');
});

describe('cancelDeliveryOrder', () => {
  it('rejects a missing order id without hitting the backend', async () => {
    const res = await cancelDeliveryOrder('');
    expect(res).toEqual({ ok: false, error: 'Missing order.' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('asks for login when there is no auth token', async () => {
    getAuthTokenMock.mockResolvedValue(null);
    const res = await cancelDeliveryOrder('do_1');
    expect(res).toEqual({
      ok: false,
      error: 'Please log in first.',
      needsAuth: true,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POSTs to the cancel route and returns the backend status', async () => {
    fetchMock.mockResolvedValue({
      order: {
        id: 'do_1',
        status: 'canceled',
        created_at: '2026-07-11T00:00:00Z',
        tracking_number: null,
        items: [],
      },
    });
    const res = await cancelDeliveryOrder('do_1');
    expect(res).toEqual({ ok: true, status: 'canceled' });
    expect(fetchMock).toHaveBeenCalledWith(
      '/store/delivery-orders/do_1/cancel',
      expect.objectContaining({
        method: 'POST',
        headers: { Authorization: 'Bearer tok' },
      }),
    );
  });

  it('still succeeds when the 2xx body is not the expected shape', async () => {
    // A 2xx means the cancel happened — a drifted body must not false-fail it.
    fetchMock.mockResolvedValue({ order: { unexpected: true } });
    const res = await cancelDeliveryOrder('do_1');
    expect(res).toEqual({ ok: true, status: 'canceled' });
  });

  it('maps the already-shipped refusal to the contact-support copy', async () => {
    fetchMock.mockRejectedValue(
      new Error(
        'This delivery is already shipped and can no longer be canceled — please contact support.',
      ),
    );
    const res = await cancelDeliveryOrder('do_1');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe(
        'This order has already shipped and can no longer be canceled — please contact support.',
      );
      expect(res.needsAuth).toBe(false);
    }
  });

  it('maps an already-canceled order to its own copy', async () => {
    fetchMock.mockRejectedValue(
      new Error('This delivery is already canceled.'),
    );
    const res = await cancelDeliveryOrder('do_1');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe('This delivery is already canceled.');
    }
  });

  it('maps 404 to a not-found message', async () => {
    fetchMock.mockRejectedValue(new Error('Order not found.'));
    const res = await cancelDeliveryOrder('do_1');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe('That order was not found.');
    }
  });

  it('maps 401 to a login prompt with needsAuth', async () => {
    fetchMock.mockRejectedValue(new Error('Unauthorized'));
    const res = await cancelDeliveryOrder('do_1');
    expect(res).toEqual({
      ok: false,
      error: 'Please log in to manage deliveries.',
      needsAuth: true,
    });
  });

  it('falls back to generic copy for an unknown error', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNRESET'));
    const res = await cancelDeliveryOrder('do_1');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe('Something went wrong. Please try again.');
    }
  });
});

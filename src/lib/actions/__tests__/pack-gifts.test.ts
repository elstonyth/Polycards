import { describe, it, expect, vi } from 'vitest';
import { storeShim, backend } from '@/lib/__tests__/store-shim';

// Same harness as wallet.test.ts: the real schema runs against an in-memory
// backend behind the port.
vi.mock('@/lib/store', () => ({ store: storeShim }));

import { getPackGifts } from '../pack-gifts';

const GIFT = {
  pack_id: 'bronze',
  count: 2,
  title: 'Bronze Pack',
  image: '/images/polycards/bronze-pack.webp',
  price: 300,
  available: true,
};

describe('getPackGifts', () => {
  it('reads the gifts no-store with the customer bearer and maps them', async () => {
    const mem = backend({
      'GET /store/pack-gifts': { body: { gifts: [GIFT] } },
    });
    expect(await getPackGifts()).toEqual([
      {
        packId: 'bronze',
        count: 2,
        title: 'Bronze Pack',
        image: '/images/polycards/bronze-pack.webp',
        price: 300,
        available: true,
      },
    ]);
    expect(mem.requests).toEqual([
      {
        method: 'GET',
        path: '/store/pack-gifts',
        headers: { Authorization: 'Bearer test-token' },
        cache: 'no-store',
      },
    ]);
  });

  it('drops a malformed row and keeps a null image', async () => {
    backend({
      'GET /store/pack-gifts': {
        body: { gifts: [{ ...GIFT, image: null }, { pack_id: 'x' }] },
      },
    });
    expect(await getPackGifts()).toEqual([
      expect.objectContaining({ packId: 'bronze', image: null }),
    ]);
  });

  it('reads as null when logged out — without calling the backend', async () => {
    const mem = backend({}, { token: null });
    expect(await getPackGifts()).toBeNull();
    expect(mem.requests).toEqual([]);
  });

  it('reads as null when the backend fails', async () => {
    backend({ 'GET /store/pack-gifts': { status: 500 } });
    expect(await getPackGifts()).toBeNull();
  });
});

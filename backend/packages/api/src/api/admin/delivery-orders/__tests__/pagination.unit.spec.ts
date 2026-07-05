jest.mock('../../../../modules/packs/delivery-view', () => ({
  serializeDeliveryOrders: async (_p: any, orders: any[]) =>
    orders.map((o) => ({ ...o, items: [], tracking_number: null })),
}));

import { GET } from '../route';

const mkRes = () => {
  const out: { body?: any } = {};
  return { res: { json: (b: any) => (out.body = b) } as any, out };
};

const order = (i: number) => ({
  id: `dord_${i}`,
  customer_id: 'cus_1',
  status: 'requested',
  created_at: new Date(2026, 0, i + 1),
});

function mkScope(totalOrders: number) {
  const all = Array.from({ length: totalOrders }, (_, i) => order(i));
  const packs = {
    listAndCountDeliveryOrders: async (_f: any, o: any) => [
      all.slice(o?.skip ?? 0, (o?.skip ?? 0) + (o?.take ?? 50)),
      all.length,
    ],
  };
  return {
    resolve: (key: string) =>
      typeof key === 'string' && key.toLowerCase().includes('customer')
        ? { listCustomers: async () => [{ id: 'cus_1', email: 'a@b.c' }] }
        : packs,
  };
}

describe('GET /admin/delivery-orders pagination', () => {
  it('returns total/offset/limit and slices', async () => {
    const { res, out } = mkRes();
    await GET(
      { scope: mkScope(120), query: { limit: '50', offset: '100' } } as any,
      res,
    );
    expect(out.body.total).toBe(120);
    expect(out.body.orders).toHaveLength(20);
    expect(out.body.offset).toBe(100);
  });
});

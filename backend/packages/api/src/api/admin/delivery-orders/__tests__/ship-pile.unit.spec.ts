jest.mock('../../../../modules/packs/delivery-view', () => ({
  serializeDeliveryOrders: async (_p: unknown, orders: object[]) =>
    orders.map((o) => ({ ...o, items: [] })),
}));

import { GET as listOrders } from '../route';
import { coerceBulkStatusBody, coerceDeliveryUpdateBody } from '../validate';
import { shipPileView } from '../ship-pile/view';

// The ship-pile check rides both admin bodies (incident 2026-11-03).
describe('pile_checked on the admin bodies', () => {
  it('passes true through on a single-order update', () => {
    expect(
      coerceDeliveryUpdateBody({ status: 'canceled', pile_checked: true }),
    ).toEqual({ status: 'canceled', pile_checked: true });
  });

  it('passes true through on a bulk update', () => {
    expect(
      coerceBulkStatusBody({
        ids: ['a'],
        status: 'canceled',
        pile_checked: true,
      }),
    ).toEqual({ ids: ['a'], status: 'canceled', pile_checked: true });
  });

  it('reads absent or false as not checked', () => {
    for (const pile_checked of [undefined, false]) {
      expect(
        coerceDeliveryUpdateBody({ status: 'canceled', pile_checked }),
      ).not.toHaveProperty('pile_checked');
      expect(
        coerceBulkStatusBody({ ids: ['a'], status: 'canceled', pile_checked }),
      ).not.toHaveProperty('pile_checked');
    }
  });

  it.each([['true'], [1], [null], [{}]])(
    'rejects a non-boolean %j rather than reading it as no',
    (pile_checked) => {
      expect(() =>
        coerceDeliveryUpdateBody({ status: 'canceled', pile_checked }),
      ).toThrow(/pile_checked/);
      expect(() =>
        coerceBulkStatusBody({ ids: ['a'], status: 'canceled', pile_checked }),
      ).toThrow(/pile_checked/);
    },
  );

  it('does not count as an update on its own', () => {
    expect(() => coerceDeliveryUpdateBody({ pile_checked: true })).toThrow(
      /Provide/,
    );
  });
});

describe('shipPileView', () => {
  const at = new Date('2026-11-03T12:48:00Z');
  const row = {
    order_id: 'do_01TESTSHIPPILE000000PILE01',
    customer_id: 'cus_1',
    from_status: 'ready_to_ship',
    canceled_by: 'user_owner',
    reason: 'mark as canceled',
    canceled_at: at,
    cleared_by: null,
    cleared_at: null,
  };
  const lookups = {
    orders: new Map([
      [row.order_id, { ship_name: 'Ali Bin Abu', ship_city: 'Ipoh' }],
    ]),
    customerEmails: new Map([['cus_1', 'player@example.com']]),
    staffEmails: new Map([['user_owner', 'owner@example.com']]),
  };

  it('names the parcel, the player and who cancelled it', () => {
    expect(shipPileView([row], lookups)).toEqual([
      {
        order_id: row.order_id,
        customer_id: 'cus_1',
        customer_email: 'player@example.com',
        ship_name: 'Ali Bin Abu',
        ship_city: 'Ipoh',
        from_status: 'ready_to_ship',
        canceled_at: at,
        canceled_by: 'owner@example.com',
        reason: 'mark as canceled',
      },
    ]);
  });

  it('says automatic for a system actor and keeps a deleted login’s id', () => {
    const [system, gone] = shipPileView(
      [
        { ...row, canceled_by: 'system:stock-allocation' },
        { ...row, canceled_by: 'user_gone' },
      ],
      lookups,
    );
    expect(system.canceled_by).toBe('automatic');
    expect(gone.canceled_by).toBe('user_gone');
  });

  it('leaves a missing order or player blank instead of failing', () => {
    const [view] = shipPileView([row], {
      orders: new Map(),
      customerEmails: new Map(),
      staffEmails: new Map(),
    });
    expect(view).toMatchObject({
      customer_email: null,
      ship_name: null,
      ship_city: null,
    });
  });
});

describe('GET /admin/delivery-orders ship_pile field', () => {
  const at = new Date('2026-11-03T12:48:00Z');
  const run = async (statuses: string[]) => {
    const orders = statuses.map((status, i) => ({
      id: `do_${i}`,
      customer_id: 'cus_1',
      status,
      tracking_snapshot: null,
    }));
    const listShipPileCancels = jest.fn(async () => [
      {
        order_id: 'do_1',
        customer_id: 'cus_1',
        from_status: 'pending_ship',
        canceled_by: 'user_1',
        reason: 'mark as canceled',
        canceled_at: at,
        cleared_by: null,
        cleared_at: null,
      },
    ]);
    const packs = {
      listAndCountDeliveryOrders: async () => [orders, orders.length],
      listShipPileCancels,
    };
    const scope = {
      resolve: (key: string) =>
        key.toLowerCase().includes('customer')
          ? { listCustomers: async () => [] }
          : packs,
    };
    const out: { body?: { orders: { id: string; ship_pile: unknown }[] } } =
      {};
    await listOrders(
      { scope, query: {} } as never,
      { json: (b: never) => (out.body = b) } as never,
    );
    return { body: out.body!, listShipPileCancels };
  };

  it('marks a canceled order that left the pile, and only that one', async () => {
    const { body, listShipPileCancels } = await run([
      'canceled',
      'canceled',
      'ready_to_ship',
    ]);
    // Asked about the page's canceled orders alone.
    expect(listShipPileCancels).toHaveBeenCalledWith({
      orderIds: ['do_0', 'do_1'],
    });
    expect(body.orders.map((o) => o.ship_pile)).toEqual([
      null,
      { from_status: 'pending_ship', canceled_at: at, cleared_at: null },
      null,
    ]);
  });

  it('skips the lookup when the page has no canceled order', async () => {
    const { body, listShipPileCancels } = await run(['requested', 'shipped']);
    expect(listShipPileCancels).not.toHaveBeenCalled();
    expect(body.orders.every((o) => o.ship_pile === null)).toBe(true);
  });
});

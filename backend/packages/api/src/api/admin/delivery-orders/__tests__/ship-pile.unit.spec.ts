jest.mock('../../../../modules/packs/delivery-view', () => ({
  serializeDeliveryOrders: async (_p: unknown, orders: object[]) =>
    orders.map((o) => ({ ...o, items: [] })),
}));

import { GET as listOrders } from '../route';
import { coerceBulkStatusBody, coerceDeliveryUpdateBody } from '../validate';
import { shipPileMark, shipPileView } from '../ship-pile/view';

// The ship-pile check rides both admin bodies (incident 2026-11-03).
describe('pile_checked on the single-order body', () => {
  it('passes true through', () => {
    expect(
      coerceDeliveryUpdateBody({ status: 'canceled', pile_checked: true }),
    ).toEqual({ status: 'canceled', pile_checked: true });
  });

  it('reads absent or false as not checked', () => {
    for (const pile_checked of [undefined, false]) {
      expect(
        coerceDeliveryUpdateBody({ status: 'canceled', pile_checked }),
      ).not.toHaveProperty('pile_checked');
    }
  });

  it.each([['true'], [1], [null], [{}]])(
    'rejects a non-boolean %j rather than reading it as no',
    (pile_checked) => {
      expect(() =>
        coerceDeliveryUpdateBody({ status: 'canceled', pile_checked }),
      ).toThrow(/pile_checked/);
    },
  );

  it('does not count as an update on its own', () => {
    expect(() => coerceDeliveryUpdateBody({ pile_checked: true })).toThrow(
      /Provide/,
    );
  });
});

describe('pile_checked_ids on the bulk body', () => {
  it('passes the confirmed ids through', () => {
    expect(
      coerceBulkStatusBody({
        ids: ['a', 'b'],
        status: 'canceled',
        pile_checked_ids: ['b'],
      }),
    ).toEqual({ ids: ['a', 'b'], status: 'canceled', pile_checked_ids: ['b'] });
  });

  it('reads absent or empty as none confirmed', () => {
    for (const pile_checked_ids of [undefined, []]) {
      expect(
        coerceBulkStatusBody({
          ids: ['a'],
          status: 'canceled',
          pile_checked_ids,
        }),
      ).toEqual({ ids: ['a'], status: 'canceled' });
    }
  });

  it.each([
    [true],
    ['a'],
    [[1]],
    // An id the request does not move cannot be confirmed.
    [['z']],
  ])('rejects %j', (pile_checked_ids) => {
    expect(() =>
      coerceBulkStatusBody({
        ids: ['a'],
        status: 'canceled',
        pile_checked_ids,
      }),
    ).toThrow(/pile_checked_ids/);
  });
});

describe('ship-pile views', () => {
  const at = new Date('2026-11-03T12:48:00Z');
  const row = {
    order_id: 'do_01TESTSHIPPILE000000PILE01',
    customer_id: 'cus_1',
    from_status: 'ready_to_ship',
    to_status: 'canceled',
    moved_by: 'user_owner',
    moved_at: at,
    cleared_by: null,
    cleared_at: null,
  };
  const lookups = {
    orders: new Map([
      [row.order_id, { ship_name: 'Ali Bin Abu', ship_city: 'Ipoh' }],
    ]),
    staffEmails: new Map([['user_owner', 'owner@example.com']]),
  };

  it('names the parcel and who moved it, as wire JSON', () => {
    expect(shipPileView([row], lookups)).toEqual([
      {
        order_id: row.order_id,
        ship_name: 'Ali Bin Abu',
        ship_city: 'Ipoh',
        from_status: 'ready_to_ship',
        to_status: 'canceled',
        moved_at: '2026-11-03T12:48:00.000Z',
        moved_by: 'owner@example.com',
      },
    ]);
  });

  it('carries no player email, player id or staff reason', () => {
    const [view] = shipPileView([row], lookups);
    for (const key of ['customer_email', 'customer_id', 'reason']) {
      expect(view).not.toHaveProperty(key);
    }
  });

  it('says automatic for a system actor and keeps a deleted login’s id', () => {
    const [system, gone] = shipPileView(
      [
        { ...row, moved_by: 'system:stock-allocation' },
        { ...row, moved_by: 'user_gone' },
      ],
      lookups,
    );
    expect(system.moved_by).toBe('automatic');
    expect(gone.moved_by).toBe('user_gone');
  });

  it('leaves a missing order blank instead of failing', () => {
    const [view] = shipPileView([row], {
      orders: new Map(),
      staffEmails: new Map(),
    });
    expect(view).toMatchObject({ ship_name: null, ship_city: null });
  });

  it('marks a row with where it left the pile and when it was cleared', () => {
    const cleared = new Date('2026-11-04T01:00:00Z');
    expect(shipPileMark({ ...row, cleared_at: cleared })).toEqual({
      from_status: 'ready_to_ship',
      to_status: 'canceled',
      moved_at: '2026-11-03T12:48:00.000Z',
      cleared_at: '2026-11-04T01:00:00.000Z',
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
    const listShipPileExits = jest.fn(async () => [
      {
        order_id: 'do_1',
        customer_id: 'cus_1',
        from_status: 'pending_ship',
        to_status: 'processed',
        moved_by: 'user_1',
        moved_at: at,
        cleared_by: null,
        cleared_at: null,
      },
    ]);
    const packs = {
      listAndCountDeliveryOrders: async () => [orders, orders.length],
      listShipPileExits,
    };
    const scope = {
      resolve: (key: string) =>
        key.toLowerCase().includes('customer')
          ? { listCustomers: async () => [] }
          : packs,
    };
    const out: { body?: { orders: { id: string; ship_pile: unknown }[] } } = {};
    await listOrders(
      { scope, query: {} } as never,
      { json: (b: never) => (out.body = b) } as never,
    );
    return { body: out.body!, listShipPileExits };
  };

  it('marks a canceled or processed order that left the pile, and only that one', async () => {
    const { body, listShipPileExits } = await run([
      'canceled',
      'processed',
      'ready_to_ship',
    ]);
    // Asked about the page's canceled and processed orders alone.
    expect(listShipPileExits).toHaveBeenCalledWith({
      orderIds: ['do_0', 'do_1'],
    });
    expect(body.orders.map((o) => o.ship_pile)).toEqual([
      null,
      {
        from_status: 'pending_ship',
        to_status: 'processed',
        moved_at: '2026-11-03T12:48:00.000Z',
        cleared_at: null,
      },
      null,
    ]);
  });

  it('skips the lookup when no order on the page could have left the pile', async () => {
    const { body, listShipPileExits } = await run(['requested', 'shipped']);
    expect(listShipPileExits).not.toHaveBeenCalled();
    expect(body.orders.every((o) => o.ship_pile === null)).toBe(true);
  });
});

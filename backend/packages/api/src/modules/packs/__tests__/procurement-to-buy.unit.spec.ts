import { buildToBuyRows, currentToBuyList } from '../procurement-view';
import { loadInventoryRows, type InventoryRow } from '../inventory-view';
import { PACKS_MODULE } from '../index';

jest.mock('../inventory-view', () => ({ loadInventoryRows: jest.fn() }));

// User 2026-11-11: staff bought duplicate cards because a goods receive note
// saved during the day only left the To buy list at 12am. Orders still join
// at 12am (owner 2026-10-28); stock is read live.
const CUT = new Date('2026-11-10T16:00:00Z'); // 12am MYT, 11 Nov
const before = new Date('2026-11-10T09:00:00Z');
const after = new Date('2026-11-11T03:00:00Z');

const inv = (over: Partial<InventoryRow> = {}): InventoryRow =>
  ({
    handle: 'card-a',
    name: 'Card A',
    sku: 'CARD-A',
    photo: null,
    graded: false,
    fmv: 10,
    on_hand: 0,
    requested: 0,
    ready_to_ship: 0,
    to_procure: 0,
    ...over,
  }) as InventoryRow;
const order = (status: string, created_at: Date, handles = ['card-a']) => ({
  status,
  created_at,
  handles,
});

describe('buildToBuyRows', () => {
  // card-a: two processed orders from before 12am, one requested since.
  const orders = [
    order('processed', before),
    order('processed', before),
    order('requested', after),
  ];

  it('a GRN takes its cards off at once', () => {
    const none = buildToBuyRows(orders, [inv({ requested: 3 })], CUT);
    expect(none[0].to_procure).toBe(2);
    const one = buildToBuyRows(
      orders,
      [inv({ requested: 3, on_hand: 1 })],
      CUT,
    );
    expect(one[0].to_procure).toBe(1);
    expect(one[0].on_hand).toBe(1);
    expect(
      buildToBuyRows(orders, [inv({ requested: 3, on_hand: 2 })], CUT),
    ).toEqual([]);
  });

  it('leaves out only requested orders placed since the 12am list', () => {
    const rows = buildToBuyRows(
      [
        order('requested', before), // a night the run missed: still counts
        order('requested', after), // can still cancel: joins at 12am
        order('ready_to_ship', after), // Refresh moved it: holds a shelf card
      ],
      [inv({ requested: 2, ready_to_ship: 1, on_hand: 1 })],
      CUT,
    );
    expect(rows[0]).toMatchObject({
      requested: 1,
      ready_to_ship: 1,
      to_procure: 1,
      oldest_order_at: before.toISOString(),
    });
  });

  it('counts every open order when there is no 12am list', () => {
    const [r] = buildToBuyRows(orders, [inv({ requested: 3 })], null);
    expect(r).toMatchObject({ requested: 3, to_procure: 3 });
  });

  it('drops a card only new orders want', () => {
    expect(
      buildToBuyRows(
        [order('requested', after, ['card-b'])],
        [inv({ handle: 'card-b', requested: 1 })],
        CUT,
      ),
    ).toEqual([]);
  });
});

describe('currentToBuyList', () => {
  const env = process.env.STOCK_AUTO_ALLOCATION;
  afterEach(() => {
    process.env.STOCK_AUTO_ALLOCATION = env;
  });

  it("serves live stock even after tonight's list was taken", async () => {
    process.env.STOCK_AUTO_ALLOCATION = 'true';
    // The 12am record still says buy 2; a GRN of 1 has been saved since.
    const stale = inv({ requested: 2, to_procure: 2 });
    const packs = {
      listProcurementSnapshots: jest
        .fn()
        .mockResolvedValue([{ taken_at: CUT, to_buy: { rows: [stale] } }]),
      openDeliveryOrdersForAllocation: jest.fn().mockResolvedValue([
        order('processed', before),
        order('processed', before),
        order('requested', after),
      ]),
      listCards: jest.fn().mockResolvedValue([]),
      listFxRates: jest.fn().mockResolvedValue([]),
    };
    (loadInventoryRows as jest.Mock).mockResolvedValue([
      inv({ requested: 3, on_hand: 1 }),
    ]);
    const container = {
      resolve: (key: string) => (key === PACKS_MODULE ? packs : { warn() {} }),
    };

    const out = await currentToBuyList(container as never, after);
    expect(out.taken_at).toBe(CUT.toISOString());
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]).toMatchObject({ to_procure: 1, on_hand: 1 });
  });
});

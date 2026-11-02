import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../../modules/packs';
import { normalizeTrackingNumber } from '../../../../modules/packs/shipment-tracking';
import { ShipmentTrackerBusy, runShipmentTracker } from '../track-run';
import { notifyDeliveryChange } from '../notify';

// The tracker's own decisions: which orders it completes, what it writes, and
// that a failed carrier call or a moved order is left alone. The carrier
// answers are faked at the fetch seam (shipment-tracking.unit.spec.ts covers
// the classifiers on real answer shapes).
const runMock = jest.fn();
jest.mock('../../../../workflows/update-delivery-order', () => ({
  updateDeliveryOrderWorkflow: () => ({ run: runMock }),
}));
jest.mock('../notify', () => ({ notifyDeliveryChange: jest.fn() }));

const notify = notifyDeliveryChange as jest.Mock;
const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
let rows: Record<
  string,
  {
    id: string;
    status: string;
    tracking_number: string | null;
    customer_id: string;
    created_at: string;
    tracking_snapshot?: unknown;
  }
>;
const packs = {
  listDeliveryOrders: jest.fn(
    async (
      filter: { id?: string; status?: string },
      opts: { skip?: number },
    ) => {
      if (filter.id) return rows[filter.id] ? [rows[filter.id]] : [];
      if (opts?.skip) return [];
      return Object.values(rows).filter((r) => r.status === filter.status);
    },
  ),
  updateDeliveryOrders: jest.fn(async () => []),
};
// The shared-number lookup: every order (any status) whose number matches
// ignoring case and spaces, as the SQL does.
const pg = {
  raw: jest.fn(async (_sql: string, [keys]: [string[]]) => ({
    rows: Object.values(rows)
      .filter((r) => r.tracking_number)
      .map((r) => ({
        customer_id: r.customer_id,
        key: normalizeTrackingNumber(r.tracking_number as string),
      }))
      .filter((r) => keys.includes(r.key)),
  })),
};
const locking = {
  acquire: jest.fn(async () => undefined),
  release: jest.fn(async () => true),
};
const container = {
  resolve: (key: string) =>
    key === PACKS_MODULE
      ? packs
      : key === Modules.LOCKING
        ? locking
        : key === ContainerRegistrationKeys.PG_CONNECTION
          ? pg
          : logger,
} as any;

const res = (status: number, body: unknown) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }) as Response;
const delivered = {
  status: 'Completed',
  granular_status: 'Completed',
  events: [
    {
      type: 'DELIVERY_SUCCESS',
      time: '2026-10-22T08:14:42Z',
      data: { is_rts: false },
    },
  ],
};
const moving = {
  status: 'Transit',
  granular_status: 'Arrived at Sorting Hub',
  events: [
    {
      type: 'HUB_INBOUND_SCAN',
      time: '2026-10-21T17:32:33Z',
      data: { hub_name: 'Sort Centre Shah Alam' },
    },
  ],
};
const fetchFn = (async (url: string | URL | Request) => {
  const u = String(url);
  if (u.includes('NVMYNINJA000000001')) return res(200, delivered);
  if (u.includes('NVMYNINJA000000002')) return res(200, moving);
  if (u.includes('NVMYNINJA000000004')) {
    return res(404, { error: { code: 150002 } });
  }
  return res(503, {});
}) as unknown as typeof fetch;

const order = (id: string, tracking: string | null, status = 'shipped') => ({
  id,
  status,
  tracking_number: tracking,
  customer_id: `cus_${id}`,
  created_at: '2026-10-01T00:00:00.000Z',
});

beforeEach(() => {
  jest.clearAllMocks();
  rows = {
    a: order('a', 'NVMYNINJA000000001'),
    b: order('b', 'NVMYNINJA000000002'),
    c: order('c', 'NVMYNINJA000000003'),
    d: order('d', null),
  };
  runMock.mockImplementation(async ({ input }) => ({
    result: { order_id: input.order_id, status: input.status },
  }));
});

describe('runShipmentTracker', () => {
  it('completes the delivered order at the carrier time, snapshots the rest, skips failures', async () => {
    const run = await runShipmentTracker(container, { fetchFn });

    expect(run).toEqual({
      checked: 2,
      completed: ['a'],
      problems: [],
      failed: ['c'],
    });
    expect(runMock).toHaveBeenCalledTimes(1);
    expect(runMock).toHaveBeenCalledWith({
      input: {
        order_id: 'a',
        status: 'completed',
        allowed_from: ['shipped'],
        delivered_at: '2026-10-22T08:14:42.000Z',
        audit: {
          adminId: 'system:shipment-tracker',
          action: 'bulk_status',
          reason: expect.stringContaining(
            'Ninja Van reports NVMYNINJA000000001 delivered',
          ),
        },
      },
    });
    // Same customer notice as a staff completion.
    expect(notify).toHaveBeenCalledWith(
      container,
      rows.a,
      { order_id: 'a', status: 'completed' },
      undefined,
    );
    // Snapshots for the two the carrier answered; none for the failed one.
    const written = packs.updateDeliveryOrders.mock.calls.map(
      (c: any) => c[0][0],
    );
    expect(written.map((w: any) => w.id)).toEqual(['a', 'b']);
    expect(written[1].tracking_snapshot).toMatchObject({
      tracking_number: 'NVMYNINJA000000002',
      carrier: 'ninjavan',
      state: 'in_transit',
      event: 'Arrived at Sorting Hub · Sort Centre Shah Alam',
    });
  });

  it('leaves an order staff moved or re-numbered since the list read', async () => {
    packs.listDeliveryOrders.mockImplementationOnce(async () => [rows.a]);
    rows.a = { ...rows.a, tracking_number: 'NVMYNINJA000000009' };
    const run = await runShipmentTracker(container, { fetchFn });
    expect(run.completed).toEqual([]);
    expect(runMock).not.toHaveBeenCalled();
  });

  it('a refused completion is counted as failed, not completed', async () => {
    runMock.mockRejectedValue({
      message: 'Cannot move a completed order to completed.',
    });
    const run = await runShipmentTracker(container, { fetchFn });
    expect(run.completed).toEqual([]);
    expect(run.failed).toEqual(['a', 'c']);
    expect(notify).not.toHaveBeenCalled();
  });

  it("never completes a number that is also on another customer's order", async () => {
    // Same customer, second order in the same parcel: still completes.
    rows.e = { ...order('e', 'NVMYNINJA000000001', 'completed'), customer_id: 'cus_a' };
    expect((await runShipmentTracker(container, { fetchFn })).completed).toEqual(['a']);

    jest.clearAllMocks();
    rows.e = order('e', 'NVMYNINJA000000001', 'completed'); // cus_e
    const run = await runShipmentTracker(container, { fetchFn });
    expect(run.completed).toEqual([]);
    expect(run.problems).toEqual(['a']);
    expect(runMock).not.toHaveBeenCalled();
    const snapA = packs.updateDeliveryOrders.mock.calls
      .map((c: any) => c[0][0])
      .find((w: any) => w.id === 'a');
    expect(snapA.tracking_snapshot).toMatchObject({
      state: 'problem',
      event: "Same tracking number is on another customer's order",
    });
  });

  it('keeps the last answer when the carrier suddenly has no record', async () => {
    const lastAnswer = {
      tracking_number: 'NVMYNINJA000000004',
      carrier: 'ninjavan',
      state: 'in_transit',
    };
    rows.f = { ...order('f', 'NVMYNINJA000000004'), tracking_snapshot: lastAnswer };
    rows.g = order('g', 'NVMYNINJA000000004');
    rows.g.customer_id = 'cus_f'; // same parcel, same customer
    const run = await runShipmentTracker(container, { fetchFn });
    expect(run.failed).toContain('f');
    const written = packs.updateDeliveryOrders.mock.calls.map((c: any) => c[0][0]);
    expect(written.find((w: any) => w.id === 'f')).toBeUndefined();
    // Never checked before: "no record" is all there is to show.
    expect(written.find((w: any) => w.id === 'g').tracking_snapshot).toMatchObject({
      state: 'not_found',
    });
  });

  it('matches a shared number whatever its case and spacing', async () => {
    rows.e = {
      ...order('e', 'nvmy ninja000000001', 'completed'),
      customer_id: 'cus_e',
    };
    const run = await runShipmentTracker(container, { fetchFn });
    expect(run.completed).toEqual([]);
    expect(run.problems).toEqual(['a']);
  });

  it('never completes on a delivery dated before the order was placed', async () => {
    rows.a = { ...rows.a, created_at: '2026-10-25T00:00:00.000Z' };
    const run = await runShipmentTracker(container, { fetchFn });
    expect(runMock).not.toHaveBeenCalled();
    expect(run.problems).toEqual(['a']);
    const snapA = packs.updateDeliveryOrders.mock.calls
      .map((c: any) => c[0][0])
      .find((w: any) => w.id === 'a');
    expect(snapA.tracking_snapshot).toMatchObject({
      state: 'problem',
      event: expect.stringContaining('before the order was placed'),
    });
  });

  it('names the admin who pressed Check tracking in the audit reason', async () => {
    await runShipmentTracker(container, { fetchFn, actor: 'user_anson' });
    expect(runMock.mock.calls[0][0].input.audit.reason).toContain(
      'Check tracking pressed by user_anson',
    );
  });

  it('checks the longest-unchecked orders first', async () => {
    rows.a.tracking_snapshot = {
      tracking_number: 'NVMYNINJA000000001',
      checked_at: '2026-10-30T08:00:00.000Z',
    };
    const asked: string[] = [];
    const spy = (async (url: string | URL | Request) => {
      asked.push(String(url).slice(-18));
      return fetchFn(url);
    }) as unknown as typeof fetch;
    await runShipmentTracker(container, { fetchFn: spy });
    expect(asked).toEqual([
      'NVMYNINJA000000002',
      'NVMYNINJA000000003',
      'NVMYNINJA000000001',
    ]);
  });

  it('refuses to start while another run holds the lock, and frees its own', async () => {
    await runShipmentTracker(container, { fetchFn });
    expect(locking.release).toHaveBeenCalledWith('shipment-tracker', {
      ownerId: (locking.acquire.mock.calls as any)[0][1].ownerId,
    });

    jest.clearAllMocks();
    locking.acquire.mockRejectedValueOnce(new Error('Failed to acquire lock'));
    const spy = jest.fn(fetchFn);
    await expect(
      runShipmentTracker(container, { fetchFn: spy as unknown as typeof fetch }),
    ).rejects.toBeInstanceOf(ShipmentTrackerBusy);
    expect(spy).not.toHaveBeenCalled();
    expect(locking.release).not.toHaveBeenCalled();
  });
});

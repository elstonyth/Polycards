import stockAllocationJob from '../stock-allocation';
import { PACKS_MODULE } from '../../modules/packs';
import { runStockAllocation } from '../../modules/packs/stock-allocation-run';
import { takeProcurementSnapshot } from '../../modules/packs/procurement-view';

// The 12am job: statuses first, then the frozen to-buy list; once per day; and
// a failed status run freezes nothing. The DB path is in
// integration-tests/http/stock-allocation.spec.ts.
jest.mock('../../modules/packs/stock-allocation-run', () => ({
  ...jest.requireActual('../../modules/packs/stock-allocation-run'),
  runStockAllocation: jest.fn(),
}));
jest.mock('../../modules/packs/procurement-view', () => ({
  ...jest.requireActual('../../modules/packs/procurement-view'),
  takeProcurementSnapshot: jest.fn(),
}));

const run = runStockAllocation as jest.Mock;
const snap = takeProcurementSnapshot as jest.Mock;
const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
const packs = { listProcurementSnapshots: jest.fn() };
const container = {
  resolve: (key: string) => (key === PACKS_MODULE ? packs : logger),
} as any;

beforeEach(() => {
  jest.clearAllMocks();
  process.env.STOCK_AUTO_ALLOCATION = 'true';
  run.mockResolvedValue({ ready: [], processed: [], failed: [] });
  snap.mockResolvedValue(0);
  packs.listProcurementSnapshots.mockResolvedValue([]);
});
afterAll(() => {
  delete process.env.STOCK_AUTO_ALLOCATION;
});

describe('stock-allocation job (12am cutoff)', () => {
  it('moves statuses, then freezes the to-buy list', async () => {
    await stockAllocationJob(container);
    expect(run).toHaveBeenCalledWith(container, { nightly: true });
    expect(snap).toHaveBeenCalledWith(container, expect.any(Date));
    expect(run.mock.invocationCallOrder[0]).toBeLessThan(
      snap.mock.invocationCallOrder[0],
    );
  });

  it('freezes nothing when the status run throws (the page stays live, a rerun is allowed)', async () => {
    run.mockRejectedValue(new Error('db blip'));
    await expect(stockAllocationJob(container)).rejects.toThrow('db blip');
    expect(snap).not.toHaveBeenCalled();
  });

  it("runs once per day: today's snapshot already exists → nothing moves", async () => {
    packs.listProcurementSnapshots.mockResolvedValue([{ id: 'ps_today' }]);
    await stockAllocationJob(container);
    expect(packs.listProcurementSnapshots).toHaveBeenCalledWith(
      { taken_at: { $gte: expect.any(Date) } },
      { take: 1 },
    );
    expect(run).not.toHaveBeenCalled();
    expect(snap).not.toHaveBeenCalled();
  });

  it('does nothing while STOCK_AUTO_ALLOCATION is off', async () => {
    process.env.STOCK_AUTO_ALLOCATION = 'false';
    await stockAllocationJob(container);
    expect(run).not.toHaveBeenCalled();
    expect(snap).not.toHaveBeenCalled();
  });
});

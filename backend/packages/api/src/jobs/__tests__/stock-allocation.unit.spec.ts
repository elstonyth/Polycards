import stockAllocationJob from '../stock-allocation';
import { runStockAllocation } from '../../modules/packs/stock-allocation-run';
import { takeProcurementSnapshot } from '../../modules/packs/procurement-view';

// The 12am job: statuses first, then the frozen to-buy list — and a failed
// status run must not leave purchasing without a list. The DB path is in
// integration-tests/http/stock-allocation.spec.ts.
jest.mock('../../modules/packs/stock-allocation-run', () => ({
  ...jest.requireActual('../../modules/packs/stock-allocation-run'),
  runStockAllocation: jest.fn(),
}));
jest.mock('../../modules/packs/procurement-view', () => ({
  takeProcurementSnapshot: jest.fn(),
}));

const run = runStockAllocation as jest.Mock;
const snap = takeProcurementSnapshot as jest.Mock;
const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
const container = { resolve: () => logger } as any;

beforeEach(() => {
  jest.clearAllMocks();
  process.env.STOCK_AUTO_ALLOCATION = 'true';
  run.mockResolvedValue({ ready: [], processed: [], failed: [] });
  snap.mockResolvedValue(0);
});
afterAll(() => {
  delete process.env.STOCK_AUTO_ALLOCATION;
});

describe('stock-allocation job (12am cutoff)', () => {
  it('moves statuses, then freezes the to-buy list', async () => {
    await stockAllocationJob(container);
    expect(run).toHaveBeenCalledWith(container, { nightly: true });
    expect(snap).toHaveBeenCalledWith(container);
    expect(run.mock.invocationCallOrder[0]).toBeLessThan(
      snap.mock.invocationCallOrder[0],
    );
  });

  it('still freezes the list when the status run throws', async () => {
    run.mockRejectedValue(new Error('db blip'));
    await stockAllocationJob(container);
    expect(snap).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('db blip'),
    );
  });

  it('does nothing while STOCK_AUTO_ALLOCATION is off', async () => {
    process.env.STOCK_AUTO_ALLOCATION = 'false';
    await stockAllocationJob(container);
    expect(run).not.toHaveBeenCalled();
    expect(snap).not.toHaveBeenCalled();
  });
});

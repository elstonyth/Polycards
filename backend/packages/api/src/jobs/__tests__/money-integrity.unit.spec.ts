import { moneyIntegrityFindings } from '../../modules/packs/money-integrity';
import { alertOps } from '../../modules/packs/ops-alert';
import moneyIntegrityJob from '../money-integrity';

jest.mock('../../modules/packs/money-integrity', () => ({
  moneyIntegrityFindings: jest.fn(),
}));
jest.mock('../../modules/packs/ops-alert', () => ({
  alertOps: jest.fn(async () => undefined),
}));

const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
const container = {
  resolve: (key: string) => (key === 'logger' ? logger : {}),
} as never;
const findings = jest.mocked(moneyIntegrityFindings);
const alert = jest.mocked(alertOps);

beforeEach(() => jest.clearAllMocks());

describe('money-integrity job', () => {
  it('stays quiet when nothing is wrong', async () => {
    findings.mockResolvedValue([]);
    await moneyIntegrityJob(container);
    expect(logger.error).not.toHaveBeenCalled();
    expect(alert).not.toHaveBeenCalled();
  });

  it('logs and alerts each finding, muted per row', async () => {
    findings.mockResolvedValue([
      {
        kind: 'sold_without_flip',
        id: 'pull_1',
        customer_id: 'cus_1',
        amount: 12.5,
        at: '2026-11-01T00:00:00Z',
      },
    ]);
    await moneyIntegrityJob(container);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0][0]).toContain('pull_1');
    expect(alert).toHaveBeenCalledWith(
      container,
      'money-integrity:pull_1',
      expect.stringContaining('pull_1'),
      { muteMs: 24 * 60 * 60 * 1000 },
    );
  });
});

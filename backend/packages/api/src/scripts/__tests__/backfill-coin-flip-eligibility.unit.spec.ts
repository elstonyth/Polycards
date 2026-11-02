import backfill from '../backfill-coin-flip-eligibility';
import { PACKS_MODULE } from '../../modules/packs';

const run = async (args: string[] | undefined) => {
  const rows = [
    { id: 'p1', customer_id: 'c1' },
    { id: 'p2', customer_id: 'c1' },
  ];
  const packs = {
    coinFlipSettings: jest.fn(async () => ({ enabled: false })),
    listPulls: jest.fn(async () => rows.splice(0)),
    finalizeLegacyPullsForCoinFlip: jest.fn(async () => undefined),
  };
  const logger = { info: jest.fn() };
  const container = {
    resolve: (key: string) => (key === PACKS_MODULE ? packs : logger),
  };
  await backfill({ container, args } as never);
  return { packs, logger };
};

describe('backfill-coin-flip-eligibility', () => {
  const previous = process.env.COIN_FLIP_INGRESS_DRAINED;
  beforeEach(() => {
    process.env.COIN_FLIP_INGRESS_DRAINED = '1';
  });
  afterAll(() => {
    process.env.COIN_FLIP_INGRESS_DRAINED = previous;
  });

  it.each([[[]], [undefined]])('only reports without apply: %p', async (args) => {
    const { packs, logger } = await run(args);
    expect(packs.finalizeLegacyPullsForCoinFlip).not.toHaveBeenCalled();
    expect(logger.info.mock.calls[0][0]).toContain('Dry run');
  });

  it('marks the cards with the positional apply that medusa exec lets through', async () => {
    const { packs } = await run(['apply']);
    expect(packs.finalizeLegacyPullsForCoinFlip).toHaveBeenCalledWith({
      customerId: 'c1',
      pullIds: ['p1', 'p2'],
      ingressDrained: true,
    });
  });

  it('includes cards in delivery, which return to the Vault on cancel', async () => {
    const { packs } = await run([]);
    expect(packs.listPulls.mock.calls[0]).toEqual([
      expect.objectContaining({ status: ['vaulted', 'delivering'] }),
      expect.anything(),
    ]);
  });

  it('refuses to apply until pack ingress is drained', async () => {
    delete process.env.COIN_FLIP_INGRESS_DRAINED;
    await expect(run(['apply'])).rejects.toThrow(/COIN_FLIP_INGRESS_DRAINED/);
  });
});

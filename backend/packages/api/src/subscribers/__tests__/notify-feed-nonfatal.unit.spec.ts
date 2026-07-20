// Regression guard for the notifyFeed producers (subscriber, cron job, store
// route). Two properties, one per axis:
//
//   1. NON-FATAL — a notification failure must never escape the producer. The
//      mutation it follows is already committed, so a throw here would surface
//      as a 500 (route) or an unhandled rejection (subscriber/job) on a request
//      that actually succeeded.
//   2. DISCOVERABLE — the failure is warned with the template name, the receiver
//      id, and the underlying error, so a silently-broken producer is findable
//      in logs.
//
// The "hostile container" cases matter more than they look. This repo's route
// harness uses `scope: { resolve: () => service }` — every key, including
// 'logger', resolves to the packs service. Against that shape a resolve-only
// guard is NOT enough: the resolve succeeds and `.warn` is undefined, so the
// emit throws. Those cases fail on a resolve-only guard and pass on the
// resolve-AND-emit guard the producers now use.
//
// settle-vip is deliberately not covered here: invoking a Medusa workflow step
// outside a workflow run is not worth the harness, and it uses the identical
// guard shape.
import { Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../modules/packs';
import vipSpendSettledHandler from '../vip-spend-settled';
import matureCommissionsJob from '../../jobs/mature-commissions';
import { POST as claimPOST } from '../../api/store/rewards/claim/[grantId]/route';

// A notification module whose provider is down — the failure mode every
// producer's catch exists for.
const failingNotif = {
  createNotifications: async () => {
    throw new Error('provider exploded');
  },
};

const loggerSpy = () => {
  const warns: string[] = [];
  return { warns, logger: { warn: (m: string) => warns.push(m) } };
};

// Well-formed container: unknown keys throw, the way awilix does.
const containerWith = (registrations: Record<string, unknown>) => ({
  resolve: (key: string) => {
    if (key in registrations) return registrations[key];
    throw new Error(`Could not resolve '${key}'`);
  },
});

describe('vip-spend-settled subscriber', () => {
  const event = { data: { customer_id: 'cus_1', open_id: 'open_1' } };
  const packs = { grantLevelUpRewards: async () => ({ gained: [2, 3] }) };

  it('swallows a notification failure and warns with template + receiver + cause', async () => {
    const { warns, logger } = loggerSpy();
    const container = containerWith({
      [PACKS_MODULE]: packs,
      [Modules.NOTIFICATION]: failingNotif,
      logger,
    });

    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vipSpendSettledHandler({ event, container } as any),
    ).resolves.toBeUndefined();

    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('vip_level_up');
    expect(warns[0]).toContain('cus_1');
    expect(warns[0]).toContain('open_1');
    expect(warns[0]).toContain('provider exploded');
  });

  it('cannot throw when the container resolves a non-logger for every key', async () => {
    // The repo's own route-test harness shape: resolve() ignores the key.
    const container = { resolve: () => packs };
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vipSpendSettledHandler({ event, container } as any),
    ).resolves.toBeUndefined();
  });
});

describe('mature-commissions job', () => {
  // Stand-in for matureDueCommissions: invokes the notify callback per flipped
  // commission with no guard of its own, so a throwing callback fails the job.
  const packsFlipping = (calls: Array<[string, string, boolean]>) => ({
    matureDueCommissions: async (
      notify: (b: string, c: string, f: boolean) => Promise<void>,
    ) => {
      for (const [b, c, f] of calls) await notify(b, c, f);
      return { flipped: calls.length };
    },
  });

  it('swallows a per-commission notification failure and warns for each', async () => {
    const { warns, logger } = loggerSpy();
    const container = containerWith({
      [PACKS_MODULE]: packsFlipping([
        ['cus_9', 'com_1', false],
        ['cus_9', 'com_2', true],
      ]),
      [Modules.NOTIFICATION]: failingNotif,
      logger,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(
      matureCommissionsJob(container as any),
    ).resolves.toBeUndefined();

    expect(warns).toHaveLength(2);
    expect(warns[0]).toContain('commission_matured');
    expect(warns[0]).toContain('cus_9');
    expect(warns[0]).toContain('com_1');
    expect(warns[0]).toContain('provider exploded');
    expect(warns[1]).toContain('com_2');
  });

  it('cannot throw when the container resolves a non-logger for every key', async () => {
    const packs = packsFlipping([['cus_9', 'com_1', false]]);
    const container = { resolve: () => packs };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(
      matureCommissionsJob(container as any),
    ).resolves.toBeUndefined();
  });
});

describe('POST /store/rewards/claim/:grantId', () => {
  const prev = process.env.REWARDS_REDEMPTION_ENABLED;
  beforeAll(() => {
    process.env.REWARDS_REDEMPTION_ENABLED = 'true';
  });
  afterAll(() => {
    if (prev === undefined) delete process.env.REWARDS_REDEMPTION_ENABLED;
    else process.env.REWARDS_REDEMPTION_ENABLED = prev;
  });

  const claimed = {
    claimed: true,
    kind: 'voucher',
    amount_myr: 25,
    level: 10,
  };
  const packs = { claimReward: async () => claimed };

  const makeReqRes = (scope: { resolve: (k: string) => unknown }) => {
    const captured: { status?: number; body?: unknown } = {};
    const res = {
      status(code: number) {
        captured.status = code;
        return this;
      },
      json(body: unknown) {
        captured.body = body;
        return this;
      },
    };
    const req = {
      auth_context: { actor_id: 'cus_7' },
      params: { grantId: 'grant_1' },
      scope,
    };
    return { req, res, captured };
  };

  it('returns the committed claim unchanged and warns when the notification fails', async () => {
    const { warns, logger } = loggerSpy();
    const { req, res, captured } = makeReqRes(
      containerWith({
        [PACKS_MODULE]: packs,
        [Modules.NOTIFICATION]: failingNotif,
        logger,
      }),
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(claimPOST(req as any, res as any)).resolves.toBeUndefined();

    // The claim committed before the notification ran — the response must be
    // byte-for-byte what claimReward returned, with no error status.
    expect(captured.body).toBe(claimed);
    expect(captured.status).toBeUndefined();

    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('voucher_claimed');
    expect(warns[0]).toContain('cus_7');
    expect(warns[0]).toContain('grant_1');
    expect(warns[0]).toContain('provider exploded');
  });

  it('still returns the claim when the container resolves a non-logger for every key', async () => {
    const { req, res, captured } = makeReqRes({ resolve: () => packs });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(claimPOST(req as any, res as any)).resolves.toBeUndefined();
    expect(captured.body).toBe(claimed);
    expect(captured.status).toBeUndefined();
  });
});

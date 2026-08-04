import PacksModuleService from '../service';

/**
 * promoteDueChallengeSchedules — the seam that makes "Add Weekly Challenge"
 * actually take over.
 *
 * Pinned here without a DB (same fake-`this` technique as
 * delivery-transition-atomic.unit.spec.ts — @InjectManager reuses a provided
 * sharedContext and calls the original method):
 *
 *  1. Only DUE + UNAPPLIED rows are read — `applied_at` is the idempotency
 *     gate, so a second run promotes nothing.
 *  2. Editions apply OLDEST FIRST, so a job that missed a tick leaves the
 *     NEWEST edition live rather than an older one.
 *  3. A row that fails to promote (e.g. a prize card deleted since it was
 *     queued) is NOT stamped, and does NOT stop the editions after it.
 *  4. A row whose STAMP fails counts as failed, not promoted — the stage save
 *     and the stamp share one transaction, so in production the save rolls
 *     back with it and the ladder is left untouched.
 */

type Row = {
  id: string;
  starts_at: Date;
  label: string | null;
  stages: unknown;
};

const stage = (n: number) => ({
  stage_number: n,
  threshold_myr: n * 1000,
  rank_rewards: [],
});

const fakeService = (
  rows: Row[],
  failOn: string[] = [],
  failStampOn: string[] = [],
) => {
  const svc = Object.create(PacksModuleService.prototype) as PacksModuleService;
  const saved: string[] = [];
  const stamped: string[] = [];

  const listChallengeSchedules = jest.fn(async () => rows);
  const saveChallengeStages = jest.fn(async (input: { reason: string }) => {
    const id = rows.find((r) => input.reason.includes(r.label ?? ''))?.id ?? '';
    if (failOn.includes(id))
      throw new Error('Unknown featured card id(s): card_gone.');
    saved.push(id);
    return [];
  });
  const updateChallengeSchedules = jest.fn(
    async (args: { selector: { id: string } }) => {
      if (failStampOn.includes(args.selector.id))
        throw new Error('stamp write failed');
      stamped.push(args.selector.id);
      return [];
    },
  );

  Object.assign(svc, {
    listChallengeSchedules,
    saveChallengeStages,
    updateChallengeSchedules,
  });
  return { svc, listChallengeSchedules, saved, stamped };
};

const NOW = new Date('2026-08-10T00:00:00.000Z');

// @InjectManager reads sharedContext.manager when present and only falls back
// to this.baseRepository_ when it is absent — a stub is enough to drive the
// method without a DB (same idiom as credit-balance.unit.spec.ts). It must be
// NON-EMPTY: the decorator's isPresent() check treats `{}` as absent and then
// throws looking for baseRepository_. Nothing here issues raw SQL, so `execute`
// is never actually called.
//
// `transactionManager` is set for the same reason on the other half:
// promoteOneChallengeSchedule is @InjectTransactionManager, and without a
// transaction already in context it would try to open a real one.
const stubManager = { execute: async () => [] };
const ctx = {
  manager: stubManager,
  transactionManager: stubManager,
} as never;

describe('promoteDueChallengeSchedules', () => {
  it('reads only due, unapplied rows, oldest first', async () => {
    const { svc, listChallengeSchedules } = fakeService([]);
    await svc.promoteDueChallengeSchedules(NOW, ctx);

    const [filters, config] = listChallengeSchedules.mock
      .calls[0] as unknown as [
      Record<string, unknown>,
      { order: Record<string, string> },
    ];
    // An `applied_at: null` filter is what makes a re-run a no-op; without it
    // every past edition would be re-promoted on every tick.
    expect(filters).toMatchObject({ applied_at: null });
    expect(filters.starts_at).toEqual({ $lte: NOW });
    expect(config.order).toEqual({ starts_at: 'ASC' });
  });

  it('promotes in queue order and stamps each row applied', async () => {
    const rows: Row[] = [
      {
        id: 'sch_1',
        starts_at: new Date('2026-08-03T00:00:00.000Z'),
        label: 'week-a',
        stages: [stage(1)],
      },
      {
        id: 'sch_2',
        starts_at: new Date('2026-08-10T00:00:00.000Z'),
        label: 'week-b',
        stages: [stage(1), stage(2)],
      },
    ];
    const { svc, saved, stamped } = fakeService(rows);

    const out = await svc.promoteDueChallengeSchedules(NOW, ctx);

    expect(out).toEqual({ promoted: 2, failed: 0 });
    // Order is the contract: the LAST save wins, so it must be the newest
    // edition the operator queued.
    expect(saved).toEqual(['sch_1', 'sch_2']);
    expect(stamped).toEqual(['sch_1', 'sch_2']);
  });

  it('leaves a failed edition unstamped without blocking later ones', async () => {
    const rows: Row[] = [
      {
        id: 'sch_bad',
        starts_at: new Date('2026-08-03T00:00:00.000Z'),
        label: 'week-a',
        stages: [stage(1)],
      },
      {
        id: 'sch_ok',
        starts_at: new Date('2026-08-10T00:00:00.000Z'),
        label: 'week-b',
        stages: [stage(1)],
      },
    ];
    const { svc, saved, stamped } = fakeService(rows, ['sch_bad']);

    const out = await svc.promoteDueChallengeSchedules(NOW, ctx);

    expect(out).toEqual({ promoted: 1, failed: 1 });
    expect(saved).toEqual(['sch_ok']);
    // Unstamped => retried next hour and still visible in the admin, which is
    // the whole recovery path.
    expect(stamped).toEqual(['sch_ok']);
  });

  it('counts a STAMP failure as failed, and still promotes later editions', async () => {
    // The dangerous half: without a shared transaction the ladder would already
    // be replaced while the row stayed due, and next hour's retry would
    // overwrite whatever an operator edited in between. Here the row must not
    // be reported promoted; in production the save rolls back with the stamp.
    const rows: Row[] = [
      {
        id: 'sch_stampfail',
        starts_at: new Date('2026-08-03T00:00:00.000Z'),
        label: 'week-a',
        stages: [stage(1)],
      },
      {
        id: 'sch_ok',
        starts_at: new Date('2026-08-10T00:00:00.000Z'),
        label: 'week-b',
        stages: [stage(1)],
      },
    ];
    const { svc, stamped } = fakeService(rows, [], ['sch_stampfail']);

    const out = await svc.promoteDueChallengeSchedules(NOW, ctx);

    expect(out).toEqual({ promoted: 1, failed: 1 });
    expect(stamped).toEqual(['sch_ok']);
  });
});

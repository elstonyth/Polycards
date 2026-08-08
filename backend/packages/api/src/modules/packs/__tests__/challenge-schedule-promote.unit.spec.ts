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
 *  5. The promoted stages come from the LOCKED RE-READ inside the per-row
 *     transaction, never from the batch list — an admin edit or delete landing
 *     between the two must win, not be silently overwritten by a stale copy.
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
  {
    failOn = [],
    failStampOn = [],
    // What the FOR UPDATE re-read inside promoteOneChallengeSchedule answers,
    // when it should differ from the batch list — the mid-batch edit/delete.
    // Missing key => the list row unchanged; explicit null => row gone.
    fresh = {},
  }: {
    failOn?: string[];
    failStampOn?: string[];
    fresh?: Record<string, Row | null>;
  } = {},
) => {
  const svc = Object.create(PacksModuleService.prototype) as PacksModuleService;
  const saved: unknown[][] = [];
  const savedIds: string[] = [];
  const stamped: string[] = [];

  const listChallengeSchedules = jest.fn(async () => rows);
  const saveChallengeStages = jest.fn(
    async (input: { reason: string; stages: unknown[] }) => {
      const id =
        rows.find((r) => input.reason.includes(r.label ?? ''))?.id ?? '';
      if (failOn.includes(id))
        throw new Error('Unknown featured card id(s): card_gone.');
      savedIds.push(id);
      saved.push(input.stages);
      return [];
    },
  );
  const updateChallengeSchedules = jest.fn(
    async (args: { selector: { id: string } }) => {
      if (failStampOn.includes(args.selector.id))
        throw new Error('stamp write failed');
      stamped.push(args.selector.id);
      return [];
    },
  );

  // The locked re-read. Keyed off the bound id parameter, exactly like the
  // real query; answers [] for a row that vanished mid-batch.
  const execute = jest.fn(async (_sql: string, params?: unknown[]) => {
    const id = params?.[0] as string;
    if (id in fresh) return fresh[id] === null ? [] : [fresh[id]];
    const row = rows.find((r) => r.id === id);
    return row ? [row] : [];
  });
  // @InjectManager / @InjectTransactionManager read the context's manager and
  // only fall back to this.baseRepository_ when absent — a stub is enough to
  // drive the methods without a DB. It must be NON-EMPTY: the decorator's
  // isPresent() check treats `{}` as absent.
  const stubManager = { execute };
  const ctx = {
    manager: stubManager,
    transactionManager: stubManager,
  } as never;

  Object.assign(svc, {
    listChallengeSchedules,
    saveChallengeStages,
    updateChallengeSchedules,
  });
  return {
    svc,
    ctx,
    listChallengeSchedules,
    updateChallengeSchedules,
    execute,
    saved,
    savedIds,
    stamped,
  };
};

const NOW = new Date('2026-08-10T00:00:00.000Z');

describe('promoteDueChallengeSchedules', () => {
  it('reads only due, unapplied rows, oldest first', async () => {
    const { svc, ctx, listChallengeSchedules } = fakeService([]);
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
    const { svc, ctx, savedIds, stamped } = fakeService(rows);

    const out = await svc.promoteDueChallengeSchedules(NOW, ctx);

    expect(out).toEqual({ promoted: 2, failed: 0 });
    // Order is the contract: the LAST save wins, so it must be the newest
    // edition the operator queued.
    expect(savedIds).toEqual(['sch_1', 'sch_2']);
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
    const { svc, ctx, savedIds, stamped } = fakeService(rows, {
      failOn: ['sch_bad'],
    });

    const out = await svc.promoteDueChallengeSchedules(NOW, ctx);

    expect(out).toEqual({ promoted: 1, failed: 1 });
    expect(savedIds).toEqual(['sch_ok']);
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
    const { svc, ctx, stamped } = fakeService(rows, {
      failStampOn: ['sch_stampfail'],
    });

    const out = await svc.promoteDueChallengeSchedules(NOW, ctx);

    expect(out).toEqual({ promoted: 1, failed: 1 });
    expect(stamped).toEqual(['sch_ok']);
  });

  it('promotes the RE-READ stages, not the batch copy, when an edit lands mid-batch', async () => {
    const listed: Row = {
      id: 'sch_1',
      starts_at: new Date('2026-08-03T00:00:00.000Z'),
      label: 'week-a',
      stages: [stage(1)],
    };
    const edited: Row = {
      ...listed,
      stages: [stage(1), stage(2)],
    };
    const { svc, ctx, saved, stamped } = fakeService([listed], {
      fresh: { sch_1: edited },
    });

    const out = await svc.promoteDueChallengeSchedules(NOW, ctx);

    expect(out).toEqual({ promoted: 1, failed: 0 });
    // The operator's edit wins — the stale batch copy must never go live.
    expect(saved).toEqual([[stage(1), stage(2)]]);
    expect(stamped).toEqual(['sch_1']);
  });

  it('skips a row deleted mid-batch: not promoted, not failed, nothing written', async () => {
    const rows: Row[] = [
      {
        id: 'sch_gone',
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
    const { svc, ctx, savedIds, stamped } = fakeService(rows, {
      fresh: { sch_gone: null },
    });

    const out = await svc.promoteDueChallengeSchedules(NOW, ctx);

    // Not failed: a removed edition is not an error to retry — it is gone.
    expect(out).toEqual({ promoted: 1, failed: 0 });
    expect(savedIds).toEqual(['sch_ok']);
    expect(stamped).toEqual(['sch_ok']);
  });

  it('skips a row rescheduled to the future mid-batch', async () => {
    const listed: Row = {
      id: 'sch_1',
      starts_at: new Date('2026-08-03T00:00:00.000Z'),
      label: 'week-a',
      stages: [stage(1)],
    };
    const { svc, ctx, savedIds, stamped } = fakeService([listed], {
      fresh: {
        sch_1: { ...listed, starts_at: new Date('2026-08-17T00:00:00.000Z') },
      },
    });

    const out = await svc.promoteDueChallengeSchedules(NOW, ctx);

    expect(out).toEqual({ promoted: 0, failed: 0 });
    expect(savedIds).toEqual([]);
    expect(stamped).toEqual([]);
  });

  it('locks the re-read and stamps on an unapplied-only selector', async () => {
    const listed: Row = {
      id: 'sch_1',
      starts_at: new Date('2026-08-03T00:00:00.000Z'),
      label: 'week-a',
      stages: [stage(1)],
    };
    const { svc, ctx, execute, updateChallengeSchedules } = fakeService([
      listed,
    ]);

    await svc.promoteDueChallengeSchedules(NOW, ctx);

    const [sql, params] = execute.mock.calls[0] as [string, unknown[]];
    // FOR UPDATE is the whole fix: a concurrent admin edit/delete blocks on
    // the row and then finds it already stamped.
    expect(sql).toMatch(/FOR UPDATE/);
    expect(sql).toMatch(/applied_at IS NULL/);
    expect(params).toEqual(['sch_1']);
    expect(updateChallengeSchedules).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: { id: 'sch_1', applied_at: null },
      }),
      expect.anything(),
    );
  });
});

// editChallengeSchedule — the transactional half of the admin edit route.
// Conflict check, write, and audit share one transaction behind the same
// FOR UPDATE lock promotion uses, so a failed audit rolls the edit back and
// concurrent writers serialize instead of clobbering each other.
describe('editChallengeSchedule', () => {
  type FreshRow = {
    id: string;
    starts_at: Date;
    label: string | null;
    stages: unknown;
    applied_at: Date | null;
  };

  const queuedRow: FreshRow = {
    id: 'sch_1',
    starts_at: new Date('2100-01-01T00:00:00.000Z'),
    label: 'old label',
    stages: [stage(1)],
    applied_at: null,
  };

  const input = () => ({
    id: 'sch_1',
    startsAt: new Date('2100-01-05T00:00:00.000Z'),
    label: 'new label',
    stages: [stage(1), stage(2)],
    adminId: 'admin_1',
    reason: 'bigger prizes',
  });

  const mkSvc = (fresh: FreshRow | null, { failAudit = false } = {}) => {
    const svc = Object.create(
      PacksModuleService.prototype,
    ) as PacksModuleService;
    const updateChallengeSchedules = jest.fn(async () => []);
    const createAdminActionAudits = jest.fn(async () => {
      if (failAudit) throw new Error('audit insert failed');
      return [];
    });
    const execute = jest.fn(async () => (fresh ? [fresh] : []));
    const stubManager = { execute };
    const ctx = {
      manager: stubManager,
      transactionManager: stubManager,
    } as never;
    Object.assign(svc, { updateChallengeSchedules, createAdminActionAudits });
    return {
      svc,
      ctx,
      updateChallengeSchedules,
      createAdminActionAudits,
      execute,
    };
  };

  it('locks the row, writes the edited stages, and audits before/after', async () => {
    const {
      svc,
      ctx,
      execute,
      updateChallengeSchedules,
      createAdminActionAudits,
    } = mkSvc(queuedRow);

    await svc.editChallengeSchedule(input(), ctx);

    const [sql, params] = execute.mock.calls[0] as unknown as [
      string,
      unknown[],
    ];
    expect(sql).toMatch(/FOR UPDATE/);
    expect(params).toEqual(['sch_1']);
    // The edited LADDER is the payload that matters — starts_at/label looking
    // right while the stages regressed is the failure this pins.
    expect(updateChallengeSchedules).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: { id: 'sch_1', applied_at: null },
        data: expect.objectContaining({ stages: [stage(1), stage(2)] }),
      }),
      expect.anything(),
    );
    expect(createAdminActionAudits).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          entity_type: 'challenge_stages',
          entity_id: 'sch_1',
          action: 'edit',
          before: expect.objectContaining({
            label: 'old label',
            stages: [stage(1)],
          }),
          after: expect.objectContaining({
            label: 'new label',
            stages: [stage(1), stage(2)],
          }),
          reason: 'bigger prizes',
        }),
      ],
      expect.anything(),
    );
  });

  it('refuses a row that already went live, writing nothing', async () => {
    const { svc, ctx, updateChallengeSchedules, createAdminActionAudits } =
      mkSvc({
        ...queuedRow,
        applied_at: new Date('2026-08-03T00:00:00.000Z'),
      });

    await expect(svc.editChallengeSchedule(input(), ctx)).rejects.toThrow(
      /already went live/,
    );
    expect(updateChallengeSchedules).not.toHaveBeenCalled();
    expect(createAdminActionAudits).not.toHaveBeenCalled();
  });

  it('404s a row that is gone, writing nothing', async () => {
    const { svc, ctx, updateChallengeSchedules } = mkSvc(null);

    await expect(svc.editChallengeSchedule(input(), ctx)).rejects.toThrow(
      /not found/,
    );
    expect(updateChallengeSchedules).not.toHaveBeenCalled();
  });

  it('propagates an audit-insert failure so the transaction rolls the edit back', async () => {
    // Unit scope can only pin the throw; the rollback itself is the
    // @InjectTransactionManager contract — audit and edit share one txn.
    const { svc, ctx, updateChallengeSchedules } = mkSvc(queuedRow, {
      failAudit: true,
    });

    await expect(svc.editChallengeSchedule(input(), ctx)).rejects.toThrow(
      /audit insert failed/,
    );
    expect(updateChallengeSchedules).toHaveBeenCalled();
  });
});

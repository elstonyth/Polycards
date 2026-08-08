import { POST } from '../route';

// POST /admin/challenge/schedule/:id — edit a QUEUED edition. What this spec
// pins: an already-promoted row is refused (its stages are the live challenge),
// the write repeats the `applied_at: null` condition in its selector so losing
// the race against the hourly promotion writes nothing, the re-read decides
// whether the edit actually landed, and a landed edit leaves an audit row.

const FUTURE = '2100-01-05T00:00:00.000Z';

const queuedRow = {
  id: 'sch_1',
  starts_at: new Date('2100-01-01T00:00:00.000Z'),
  label: 'old label',
  applied_at: null,
  stages: [{ stage_number: 1, threshold_myr: 500, rank_rewards: [] }],
};

const body = () => ({
  reason: 'bigger prizes',
  starts_at: FUTURE,
  label: 'new label',
  stages: [{ stage_number: 1, threshold_myr: 1000, rank_rewards: [] }],
});

const listChallengeSchedules = jest.fn();
const updateChallengeSchedules = jest.fn();
const createAdminActionAudits = jest.fn();

const mkReq = (reqBody: unknown) => ({
  auth_context: { actor_id: 'admin_1' },
  params: { id: 'sch_1' },
  body: reqBody,
  scope: {
    resolve: () => ({
      listChallengeSchedules,
      updateChallengeSchedules,
      createAdminActionAudits,
    }),
  },
});

const mkRes = () => {
  const out: { body?: unknown } = {};
  return { res: { json: (b: unknown) => (out.body = b) } as never, out };
};

beforeEach(() => {
  listChallengeSchedules.mockReset();
  updateChallengeSchedules.mockReset().mockResolvedValue([]);
  createAdminActionAudits.mockReset().mockResolvedValue([]);
});

describe('POST /admin/challenge/schedule/:id', () => {
  it('updates on an unapplied-only selector and writes an audit row', async () => {
    const edited = {
      ...queuedRow,
      starts_at: new Date(FUTURE),
      label: 'new label',
    };
    listChallengeSchedules
      .mockResolvedValueOnce([queuedRow])
      .mockResolvedValueOnce([edited]);
    const { res, out } = mkRes();

    await POST(mkReq(body()) as never, res);

    // The selector, not just the id — the guard against the promotion race.
    expect(updateChallengeSchedules).toHaveBeenCalledWith({
      selector: { id: 'sch_1', applied_at: null },
      data: expect.objectContaining({
        starts_at: new Date(FUTURE),
        label: 'new label',
      }),
    });
    expect(createAdminActionAudits).toHaveBeenCalledWith([
      expect.objectContaining({
        entity_type: 'challenge_stages',
        entity_id: 'sch_1',
        action: 'edit',
        before: expect.objectContaining({ label: 'old label' }),
        after: expect.objectContaining({ label: 'new label' }),
        reason: 'bigger prizes',
      }),
    ]);
    expect(out.body).toMatchObject({
      schedule: { id: 'sch_1', label: 'new label' },
    });
  });

  it('refuses a row that already went live, without writing', async () => {
    listChallengeSchedules.mockResolvedValueOnce([
      { ...queuedRow, applied_at: new Date('2026-08-03T00:00:00.000Z') },
    ]);
    const { res } = mkRes();

    await expect(POST(mkReq(body()) as never, res)).rejects.toThrow(
      /already went live/,
    );
    expect(updateChallengeSchedules).not.toHaveBeenCalled();
    expect(createAdminActionAudits).not.toHaveBeenCalled();
  });

  it('reports a mid-edit promotion instead of a false success', async () => {
    listChallengeSchedules
      .mockResolvedValueOnce([queuedRow])
      // The re-read: promotion stamped the row between check and write.
      .mockResolvedValueOnce([
        { ...queuedRow, applied_at: new Date('2100-01-02T00:00:00.000Z') },
      ]);
    const { res } = mkRes();

    await expect(POST(mkReq(body()) as never, res)).rejects.toThrow(
      /went live/,
    );
    // No audit for an edit that did not land.
    expect(createAdminActionAudits).not.toHaveBeenCalled();
  });

  it('404s an unknown id', async () => {
    listChallengeSchedules.mockResolvedValueOnce([]);
    const { res } = mkRes();

    await expect(POST(mkReq(body()) as never, res)).rejects.toThrow(
      /not found/,
    );
  });

  it('trims the label and maps blank to null (shared parseScheduleFields)', async () => {
    listChallengeSchedules
      .mockResolvedValueOnce([queuedRow])
      .mockResolvedValueOnce([{ ...queuedRow, label: null }]);
    const { res } = mkRes();

    await POST(mkReq({ ...body(), label: '   ' }) as never, res);

    expect(updateChallengeSchedules).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ label: null }),
      }),
    );
  });

  it('rejects a start in the past (same gate as queueing)', async () => {
    const { res } = mkRes();
    await expect(
      POST(
        mkReq({ ...body(), starts_at: '2020-01-01T00:00:00.000Z' }) as never,
        res,
      ),
    ).rejects.toThrow(/future/);
    expect(listChallengeSchedules).not.toHaveBeenCalled();
  });
});

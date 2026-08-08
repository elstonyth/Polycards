import { POST } from '../route';

// POST /admin/challenge/schedule/:id — edit a QUEUED edition. The conflict
// check, write, and audit live in the service transaction
// (editChallengeSchedule — pinned in challenge-schedule-promote.unit.spec.ts);
// what this spec pins is the handler's own job: the payload gates run BEFORE
// the service is touched, the validated values are what the service receives,
// and service refusals surface instead of a success body.

const FUTURE = '2100-01-05T00:00:00.000Z';

const body = () => ({
  reason: 'bigger prizes',
  starts_at: FUTURE,
  label: 'new label',
  stages: [{ stage_number: 1, threshold_myr: 1000, rank_rewards: [] }],
});

const editChallengeSchedule = jest.fn();

const mkReq = (reqBody: unknown) => ({
  auth_context: { actor_id: 'admin_1' },
  params: { id: 'sch_1' },
  body: reqBody,
  scope: { resolve: () => ({ editChallengeSchedule }) },
});

const mkRes = () => {
  const out: { body?: unknown } = {};
  return { res: { json: (b: unknown) => (out.body = b) } as never, out };
};

beforeEach(() => {
  editChallengeSchedule.mockReset().mockResolvedValue(undefined);
});

describe('POST /admin/challenge/schedule/:id', () => {
  it('passes the validated fields to the service and echoes them as the row', async () => {
    const { res, out } = mkRes();

    await POST(mkReq(body()) as never, res);

    expect(editChallengeSchedule).toHaveBeenCalledWith({
      id: 'sch_1',
      startsAt: new Date(FUTURE),
      label: 'new label',
      stages: [{ stage_number: 1, threshold_myr: 1000, rank_rewards: [] }],
      adminId: 'admin_1',
      reason: 'bigger prizes',
    });
    expect(out.body).toMatchObject({
      schedule: {
        id: 'sch_1',
        starts_at: FUTURE,
        label: 'new label',
        applied_at: null,
        stages: [{ stage_number: 1, threshold_myr: 1000, rank_rewards: [] }],
      },
    });
  });

  it('surfaces a service refusal instead of a success body', async () => {
    editChallengeSchedule.mockRejectedValue(
      new Error(
        'This challenge already went live — edit the live stages instead.',
      ),
    );
    const { res, out } = mkRes();

    await expect(POST(mkReq(body()) as never, res)).rejects.toThrow(
      /already went live/,
    );
    expect(out.body).toBeUndefined();
  });

  it('trims the label and maps blank to null (shared parseScheduleFields)', async () => {
    const { res } = mkRes();

    await POST(mkReq({ ...body(), label: '   ' }) as never, res);

    expect(editChallengeSchedule).toHaveBeenCalledWith(
      expect.objectContaining({ label: null }),
    );
  });

  it('rejects a start in the past before touching the service', async () => {
    const { res } = mkRes();

    await expect(
      POST(
        mkReq({ ...body(), starts_at: '2020-01-01T00:00:00.000Z' }) as never,
        res,
      ),
    ).rejects.toThrow(/future/);
    expect(editChallengeSchedule).not.toHaveBeenCalled();
  });

  it('rejects an invalid stage ladder before touching the service', async () => {
    const { res } = mkRes();

    await expect(
      POST(
        mkReq({
          ...body(),
          stages: [{ stage_number: 2, threshold_myr: 1000, rank_rewards: [] }],
        }) as never,
        res,
      ),
    ).rejects.toThrow(/stage_number/);
    expect(editChallengeSchedule).not.toHaveBeenCalled();
  });

  it('requires a reason before touching the service', async () => {
    const { res } = mkRes();

    await expect(
      POST(mkReq({ ...body(), reason: '' }) as never, res),
    ).rejects.toThrow(/reason/i);
    expect(editChallengeSchedule).not.toHaveBeenCalled();
  });
});

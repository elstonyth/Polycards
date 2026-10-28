import { parseWithdrawalControlsBody } from '../validate';

const NOW = Date.parse('2026-10-17T12:00:00+08:00');

const channel = (over: Record<string, unknown> = {}) => ({
  open: true,
  off_until: null,
  schedule: { on: false, close_at: null, reopen_at: null },
  ...over,
});
const body = (over: Record<string, unknown> = {}) => ({
  withdrawals: channel(),
  tng: { ...channel(), min_rm: null },
  ...over,
});
const parse = (b: unknown) => parseWithdrawalControlsBody(b, NOW);

describe('parseWithdrawalControlsBody', () => {
  it('accepts the whole set and returns exactly the controls', () => {
    expect(
      parse({
        ...body({
          withdrawals: channel({
            open: false,
            off_until: '2026-10-18T06:00:00+08:00',
            schedule: { on: true, close_at: '23:00', reopen_at: '06:00' },
          }),
          tng: { ...channel(), min_rm: 150 },
        }),
        reason: 'gateway maintenance',
      }),
    ).toEqual({
      withdrawals: {
        open: false,
        off_until: '2026-10-17T22:00:00.000Z',
        schedule: { on: true, close_at: '23:00', reopen_at: '06:00' },
      },
      tng: {
        open: true,
        off_until: null,
        schedule: { on: false, close_at: null, reopen_at: null },
        min_rm: 150,
      },
    });
  });

  it('keeps saved times while the schedule is off, and reads blank as none', () => {
    expect(
      parse(
        body({
          withdrawals: channel({
            schedule: { on: false, close_at: '01:00', reopen_at: '' },
          }),
        }),
      ).withdrawals.schedule,
    ).toEqual({ on: false, close_at: '01:00', reopen_at: null });
  });

  it('drops a reopen time on a switch that is on', () => {
    expect(
      parse(
        body({
          withdrawals: channel({ off_until: '2026-10-18T06:00:00+08:00' }),
        }),
      ).withdrawals.off_until,
    ).toBeNull();
  });

  it.each([
    [
      'a missing channel',
      { withdrawals: undefined },
      /withdrawals is required/,
    ],
    [
      'a non-boolean switch',
      { withdrawals: channel({ open: 'yes' }) },
      /withdrawals.open must be true or false/,
    ],
    [
      'a reopen time in the past',
      {
        withdrawals: channel({
          open: false,
          off_until: '2026-10-17T11:59:00+08:00',
        }),
      },
      /withdrawals.off_until must be in the future/,
    ],
    [
      'a reopen time that is not a date',
      { tng: { ...channel({ open: false, off_until: 'soon' }), min_rm: null } },
      /tng.off_until must be an ISO date-time/,
    ],
    [
      'a malformed time',
      {
        tng: {
          ...channel({
            schedule: { on: false, close_at: '6am', reopen_at: null },
          }),
          min_rm: null,
        },
      },
      /tng.schedule.close_at must be a 24-hour time/,
    ],
    [
      'a schedule turned on without both times',
      {
        withdrawals: channel({
          schedule: { on: true, close_at: '00:00', reopen_at: null },
        }),
      },
      /set both the close and reopen times/,
    ],
    [
      'a zero-length window',
      {
        withdrawals: channel({
          schedule: { on: true, close_at: '03:00', reopen_at: '03:00' },
        }),
      },
      /must differ/,
    ],
    [
      'a TNG minimum below the provider floor',
      { tng: { ...channel(), min_rm: 50 } },
      /between RM 100 and RM 30,000/,
    ],
    [
      'a TNG minimum above the payout ceiling',
      { tng: { ...channel(), min_rm: 30_001 } },
      /between RM 100/,
    ],
    [
      'a TNG minimum with sub-sen digits',
      { tng: { ...channel(), min_rm: 100.005 } },
      /between RM 100/,
    ],
  ])('refuses %s', (_label, over, message) => {
    expect(() => parse(body(over))).toThrow(message);
  });
});

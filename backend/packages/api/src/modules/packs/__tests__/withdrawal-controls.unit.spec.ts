import {
  DEFAULT_WITHDRAWAL_CONTROLS,
  TNG_MIN_FLOOR_RM,
  channelStatus,
  destinationMinRm,
  mytWhen,
  parseWithdrawalControls,
  tngPausedMessage,
  withdrawalsClosedMessage,
  type ChannelControl,
} from '../withdrawal-controls';

const at = (myt: string) => Date.parse(`${myt}+08:00`);
const iso = (myt: string) => new Date(at(myt)).toISOString();

const scheduled = (close_at: string, reopen_at: string): ChannelControl => ({
  open: true,
  off_until: null,
  schedule: { on: true, close_at, reopen_at },
});
const switchedOff = (
  off_until: string | null,
  schedule = DEFAULT_WITHDRAWAL_CONTROLS.withdrawals.schedule,
): ChannelControl => ({ open: false, off_until, schedule });

describe('channelStatus — switch + daily closed window (Malaysia time)', () => {
  it('is open by default', () => {
    expect(
      channelStatus(DEFAULT_WITHDRAWAL_CONTROLS.withdrawals, Date.now()),
    ).toEqual({ open: true });
  });

  it('is closed with no known end when switched off with no reopen time', () => {
    const off = { ...scheduled('00:00', '06:00'), open: false };
    expect(channelStatus(off, at('2026-10-17T12:00:00'))).toEqual({
      open: false,
      reopens_at: null,
    });
  });

  it('stays off until off_until, then reopens by itself', () => {
    const off = switchedOff(iso('2026-10-18T09:00:00'));
    expect(channelStatus(off, at('2026-10-17T12:00:00'))).toEqual({
      open: false,
      reopens_at: at('2026-10-18T09:00:00'),
    });
    expect(channelStatus(off, at('2026-10-18T09:00:00'))).toEqual({
      open: true,
    });
  });

  it('reopening into a running daily window names the window’s end', () => {
    const off = switchedOff(iso('2026-10-18T02:00:00'), {
      on: true,
      close_at: '00:00',
      reopen_at: '06:00',
    });
    expect(channelStatus(off, at('2026-10-17T12:00:00'))).toEqual({
      open: false,
      reopens_at: at('2026-10-18T06:00:00'),
    });
    // Past off_until the daily window alone decides.
    expect(channelStatus(off, at('2026-10-18T03:00:00'))).toEqual({
      open: false,
      reopens_at: at('2026-10-18T06:00:00'),
    });
  });

  it('closes inside a same-day window and names today’s reopen time', () => {
    const c = scheduled('00:00', '06:00');
    expect(channelStatus(c, at('2026-10-17T03:15:00'))).toEqual({
      open: false,
      reopens_at: at('2026-10-17T06:00:00'),
    });
    expect(channelStatus(c, at('2026-10-17T05:59:59'))).toEqual({
      open: false,
      reopens_at: at('2026-10-17T06:00:00'),
    });
  });

  it('opens on the reopen minute and before the close minute', () => {
    const c = scheduled('00:00', '06:00');
    expect(channelStatus(c, at('2026-10-17T06:00:00'))).toEqual({ open: true });
    expect(channelStatus(c, at('2026-10-17T23:59:59'))).toEqual({ open: true });
  });

  it('wraps past midnight: 23:00 → 06:00 reopens tomorrow when closed late', () => {
    const c = scheduled('23:00', '06:00');
    expect(channelStatus(c, at('2026-10-17T23:30:00'))).toEqual({
      open: false,
      reopens_at: at('2026-10-18T06:00:00'),
    });
    expect(channelStatus(c, at('2026-10-18T01:00:00'))).toEqual({
      open: false,
      reopens_at: at('2026-10-18T06:00:00'),
    });
    expect(channelStatus(c, at('2026-10-17T22:59:00'))).toEqual({ open: true });
    expect(channelStatus(c, at('2026-10-17T12:00:00'))).toEqual({ open: true });
  });

  it('ignores a schedule that is off, incomplete or zero-length', () => {
    const now = at('2026-10-17T03:00:00');
    const off: ChannelControl = {
      open: true,
      off_until: null,
      schedule: { on: false, close_at: '00:00', reopen_at: '06:00' },
    };
    const half: ChannelControl = {
      open: true,
      off_until: null,
      schedule: { on: true, close_at: '00:00', reopen_at: null },
    };
    expect(channelStatus(off, now)).toEqual({ open: true });
    expect(channelStatus(half, now)).toEqual({ open: true });
    expect(channelStatus(scheduled('03:00', '03:00'), now)).toEqual({
      open: true,
    });
  });
});

describe('parseWithdrawalControls — the stored blob', () => {
  it('reads NULL (never edited) as everything open', () => {
    expect(parseWithdrawalControls(null)).toEqual(DEFAULT_WITHDRAWAL_CONTROLS);
  });

  it('keeps what the admin route wrote and drops malformed values', () => {
    expect(
      parseWithdrawalControls({
        withdrawals: {
          open: false,
          off_until: '2026-10-18T01:00:00.000Z',
          schedule: { on: true, close_at: '23:00', reopen_at: '6am' },
        },
        tng: { open: true, off_until: 'soon', schedule: {}, min_rm: 150 },
      }),
    ).toEqual({
      withdrawals: {
        open: false,
        off_until: '2026-10-18T01:00:00.000Z',
        schedule: { on: true, close_at: '23:00', reopen_at: null },
      },
      tng: {
        open: true,
        off_until: null,
        schedule: { on: false, close_at: null, reopen_at: null },
        min_rm: 150,
      },
    });
  });
});

describe('destinationMinRm — the Touch ’n Go floor', () => {
  const withMin = (min_rm: number | null) => ({
    ...DEFAULT_WITHDRAWAL_CONTROLS,
    tng: { ...DEFAULT_WITHDRAWAL_CONTROLS.tng, min_rm },
  });

  it('is the provider floor (RM 100) until the admin sets one', () => {
    expect(TNG_MIN_FLOOR_RM).toBe(100);
    expect(destinationMinRm('TNGMY', withMin(null))).toBe(100);
  });

  it('takes the admin minimum, never below the provider floor', () => {
    expect(destinationMinRm('TNGMY', withMin(250))).toBe(250);
    expect(destinationMinRm('MYTNGO', withMin(250))).toBe(250);
    expect(destinationMinRm('TNGMY', withMin(20))).toBe(100);
  });

  it('leaves banks without a floor alone', () => {
    expect(destinationMinRm('MBBEMYKL', withMin(250))).toBeNull();
  });
});

describe('reopen wording (Malaysia time)', () => {
  const now = at('2026-10-17T22:00:00');

  it('says the time today, "tomorrow", or the day and date after that', () => {
    expect(mytWhen(at('2026-10-17T23:30:00'), now)).toBe('11:30 PM');
    expect(mytWhen(at('2026-10-18T06:00:00'), now)).toBe('6:00 AM tomorrow');
    expect(mytWhen(at('2026-10-20T09:00:00'), now)).toBe('Tue 20 Oct, 9:00 AM');
  });

  it('names the reopen time in the refusals, or says later', () => {
    jest.useFakeTimers({ now });
    try {
      expect(withdrawalsClosedMessage(at('2026-10-18T06:00:00'))).toBe(
        'Withdrawals are paused for maintenance until 6:00 AM tomorrow (Malaysia time). Please try again then.',
      );
      expect(withdrawalsClosedMessage(null)).toBe(
        'Withdrawals are paused for maintenance. Please try again later.',
      );
      expect(tngPausedMessage(at('2026-10-17T23:00:00'))).toBe(
        "Touch 'n Go withdrawals are paused until 11:00 PM. Pick another saved account, or try again then.",
      );
      expect(tngPausedMessage(null)).toBe(
        "Touch 'n Go withdrawals are paused for now. Pick another saved account, or try again later.",
      );
    } finally {
      jest.useRealTimers();
    }
  });
});

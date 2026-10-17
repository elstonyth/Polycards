import { bankPayoutMinRm, findBank } from './banks';

/**
 * Admin withdrawal controls (2026-10-17), set on the admin Withdrawals page
 * and stored whole in site_settings.withdrawal_controls:
 *
 *  - `withdrawals` — the customer's Withdraw button. Closed, POST
 *    /store/credits/withdraw refuses every NEW payout (before any row or
 *    debit) and /store/payments/config tells the storefront to answer the
 *    button with an "unavailable" popup naming the reopen time. It never
 *    touches payouts already in flight: the reconcile sweep, callbacks and
 *    held-payout approval keep running, so nobody's money gets stuck.
 *  - `tng` — payouts to Touch 'n Go only, same rules, plus `min_rm`, a floor
 *    the admin may raise above the provider's (RM 100) but never lower.
 *
 * A channel is closed while its switch is off — until `off_until` if the
 * admin set one, after which it reopens by itself — or while its daily closed
 * window (wall-clock Malaysia time, may wrap past midnight) is running.
 * Decided per request from the clock; no job flips a flag, so every change
 * lands on the minute.
 *
 * These sit ON TOP of the env switches (GATEWAY_WITHDRAWALS_ENABLED,
 * GATEWAY_WITHDRAWALS_PAUSED_UNTIL, TNG_PAYOUTS_ENABLED): the env stays the
 * ops lever, and turning a switch on here cannot open what the env keeps shut.
 */
export type DailyClosure = {
  on: boolean;
  /** "HH:MM", Malaysia time. */
  close_at: string | null;
  reopen_at: string | null;
};
export type ChannelControl = {
  open: boolean;
  /** ISO instant a switched-off channel reopens by itself; null = only an
   *  admin reopens it. Ignored while `open`. */
  off_until: string | null;
  schedule: DailyClosure;
};
export type WithdrawalControls = {
  withdrawals: ChannelControl;
  tng: ChannelControl & { min_rm: number | null };
};
export type ChannelStatus =
  | { open: true }
  /** reopens_at: epoch ms, or null when only an admin can reopen it. */
  | { open: false; reopens_at: number | null };

export const TNG_BANK_ID = 'TNGMY';
/** The provider refuses a Touch 'n Go payout below this — after our debit. */
export const TNG_MIN_FLOOR_RM = bankPayoutMinRm(TNG_BANK_ID) ?? 0;
export const TIME_OF_DAY = /^([01]\d|2[0-3]):[0-5]\d$/;

// Malaysia keeps UTC+8 all year (no DST), so a fixed offset is exact.
const MYT_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const noSchedule = (): DailyClosure => ({
  on: false,
  close_at: null,
  reopen_at: null,
});

export const DEFAULT_WITHDRAWAL_CONTROLS: WithdrawalControls = {
  withdrawals: { open: true, off_until: null, schedule: noSchedule() },
  tng: { open: true, off_until: null, schedule: noSchedule(), min_rm: null },
};

const record = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};

const timeOrNull = (v: unknown): string | null =>
  typeof v === 'string' && TIME_OF_DAY.test(v) ? v : null;

const instantOrNull = (v: unknown): string | null =>
  typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : null;

function parseChannel(raw: unknown): ChannelControl {
  const c = record(raw);
  const s = record(c.schedule);
  return {
    open: c.open !== false,
    off_until: instantOrNull(c.off_until),
    schedule: {
      on: s.on === true,
      close_at: timeOrNull(s.close_at),
      reopen_at: timeOrNull(s.reopen_at),
    },
  };
}

/**
 * The stored blob, read leniently: a missing field takes its default (open,
 * no schedule). Only the validated admin route writes it, so in practice this
 * meets that route's output or NULL (never edited).
 */
export function parseWithdrawalControls(raw: unknown): WithdrawalControls {
  const c = record(raw);
  const min = record(c.tng).min_rm;
  return {
    withdrawals: parseChannel(c.withdrawals),
    tng: {
      ...parseChannel(c.tng),
      min_rm: typeof min === 'number' && Number.isFinite(min) ? min : null,
    },
  };
}

const minutesOf = (hhmm: string): number =>
  Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Is the daily closed window running at `now`, and when does it end? */
function scheduleStatus(schedule: DailyClosure, now: number): ChannelStatus {
  const { on, close_at, reopen_at } = schedule;
  if (!on || !close_at || !reopen_at) return { open: true };
  const close = minutesOf(close_at);
  const reopen = minutesOf(reopen_at);
  if (close === reopen) return { open: true };
  const intoDay = (((now + MYT_OFFSET_MS) % DAY_MS) + DAY_MS) % DAY_MS;
  const minute = Math.floor(intoDay / 60_000);
  const inside =
    close < reopen
      ? minute >= close && minute < reopen
      : minute >= close || minute < reopen;
  if (!inside) return { open: true };
  let reopensAt = now - intoDay + reopen * 60_000;
  if (reopensAt <= now) reopensAt += DAY_MS;
  return { open: false, reopens_at: reopensAt };
}

/** Is this channel open at `now`, and if not, when does it reopen? */
export function channelStatus(
  control: ChannelControl,
  now: number,
): ChannelStatus {
  if (!control.open) {
    const until =
      control.off_until === null ? null : Date.parse(control.off_until);
    if (until === null) return { open: false, reopens_at: null };
    if (now < until) {
      // Reopening into a running daily window waits for that window's end.
      const then = scheduleStatus(control.schedule, until);
      return { open: false, reopens_at: then.open ? until : then.reopens_at };
    }
  }
  return scheduleStatus(control.schedule, now);
}

export const isTngBank = (bankCode: string | null | undefined): boolean =>
  findBank(bankCode)?.id === TNG_BANK_ID;

/** A destination's payout floor (RM): the bank's own, raised for Touch 'n Go
 *  by the admin's minimum. Null when only the gateway's band applies. */
export function destinationMinRm(
  bankCode: string,
  controls: WithdrawalControls,
): number | null {
  const own = bankPayoutMinRm(bankCode);
  if (!isTngBank(bankCode) || controls.tng.min_rm === null) return own;
  return Math.max(own ?? 0, controls.tng.min_rm);
}

const myt = (at: number, options: Intl.DateTimeFormatOptions, locale = 'en-US') =>
  new Date(at).toLocaleString(locale, { timeZone: 'Asia/Kuala_Lumpur', ...options });

/** "6:00 AM", "6:00 AM tomorrow" or "Sat 18 Oct, 6:00 AM" — Malaysia time,
 *  the only market. */
export function mytWhen(at: number, now: number = Date.now()): string {
  const time = myt(at, { hour: 'numeric', minute: '2-digit' });
  const day = (t: number) => Math.floor((t + MYT_OFFSET_MS) / DAY_MS);
  const ahead = day(at) - day(now);
  if (ahead === 0) return time;
  if (ahead === 1) return `${time} tomorrow`;
  const date = myt(at, { weekday: 'short', day: 'numeric', month: 'short' }, 'en-GB');
  return `${date}, ${time}`;
}

/** The refusal for any payout while the Withdraw switch or its window is
 *  closed. */
export const withdrawalsClosedMessage = (reopensAt: number | null): string =>
  reopensAt === null
    ? 'Withdrawals are paused for maintenance. Please try again later.'
    : `Withdrawals are paused for maintenance until ${mytWhen(reopensAt)} (Malaysia time). Please try again then.`;

/** Why a saved Touch 'n Go account cannot be picked while TNG is closed. */
export const tngPausedReason = (reopensAt: number | null): string =>
  reopensAt === null
    ? "Touch 'n Go withdrawals are paused for now"
    : `Touch 'n Go withdrawals are paused until ${mytWhen(reopensAt)}`;

/** The refusal for a payout to Touch 'n Go while TNG is closed. */
export const tngPausedMessage = (reopensAt: number | null): string =>
  `${tngPausedReason(reopensAt)}. Pick another saved account, or try again ${reopensAt === null ? 'later' : 'then'}.`;

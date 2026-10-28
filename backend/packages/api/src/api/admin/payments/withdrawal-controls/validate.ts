import { MedusaError } from '@medusajs/framework/utils';
import { GATEWAYS } from '../../../../modules/packs/gateway';
import {
  TIME_OF_DAY,
  TNG_MIN_FLOOR_RM,
  type ChannelControl,
  type WithdrawalControls,
} from '../../../../modules/packs/withdrawal-controls';

// A Touch 'n Go minimum above the payout ceiling would close TNG outright —
// that is the switch's job, so it is refused.
const TNG_MIN_CEILING_RM = GATEWAYS.tgpay.limits.withdrawalMax;

const invalid = (message: string): never => {
  throw new MedusaError(MedusaError.Types.INVALID_DATA, message);
};

const object = (value: unknown, field: string): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : invalid(`${field} is required.`);

const bool = (value: unknown, field: string): boolean =>
  typeof value === 'boolean'
    ? value
    : invalid(`${field} must be true or false.`);

const time = (value: unknown, field: string): string | null => {
  if (value === null || value === undefined || value === '') return null;
  return typeof value === 'string' && TIME_OF_DAY.test(value)
    ? value
    : invalid(`${field} must be a 24-hour time like 06:00.`);
};

// A switch-off's automatic reopen: an ISO instant in the future, or none.
const offUntil = (value: unknown, field: string, nowMs: number): string | null => {
  if (value === null || value === undefined || value === '') return null;
  const at = typeof value === 'string' ? Date.parse(value) : NaN;
  if (Number.isNaN(at)) return invalid(`${field} must be an ISO date-time.`);
  if (at <= nowMs) return invalid(`${field} must be in the future.`);
  return new Date(at).toISOString();
};

function channel(value: unknown, field: string, nowMs: number): ChannelControl {
  const c = object(value, field);
  const s = object(c.schedule, `${field}.schedule`);
  const on = bool(s.on, `${field}.schedule.on`);
  const close_at = time(s.close_at, `${field}.schedule.close_at`);
  const reopen_at = time(s.reopen_at, `${field}.schedule.reopen_at`);
  if (on && (close_at === null || reopen_at === null))
    invalid(
      `${field}: set both the close and reopen times to turn the schedule on.`,
    );
  if (on && close_at === reopen_at)
    invalid(`${field}: the close and reopen times must differ.`);
  const open = bool(c.open, `${field}.open`);
  return {
    open,
    // Meaningless while open, so never stored then.
    off_until: open ? null : offUntil(c.off_until, `${field}.off_until`, nowMs),
    schedule: { on, close_at, reopen_at },
  };
}

function minRm(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const ok =
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= TNG_MIN_FLOOR_RM &&
    value <= TNG_MIN_CEILING_RM &&
    Math.abs(value * 100 - Math.round(value * 100)) < 1e-6;
  return ok
    ? (value as number)
    : invalid(
        `tng.min_rm must be between RM ${TNG_MIN_FLOOR_RM} and RM ${TNG_MIN_CEILING_RM.toLocaleString('en-US')} (or empty for RM ${TNG_MIN_FLOOR_RM}).`,
      );
}

/** The whole control set for POST /admin/payments/withdrawal-controls.
 *  `nowMs` is a parameter so the off_until edge is testable. */
export function parseWithdrawalControlsBody(
  body: unknown,
  nowMs: number,
): WithdrawalControls {
  const raw = (body ?? {}) as Record<string, unknown>;
  const tng = object(raw.tng, 'tng');
  return {
    withdrawals: channel(raw.withdrawals, 'withdrawals', nowMs),
    tng: { ...channel(tng, 'tng', nowMs), min_rm: minRm(tng.min_rm) },
  };
}

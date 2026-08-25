import { MedusaError } from '@medusajs/framework/utils';
import { FRAME_LEVELS } from './avatar-frames';
import { MAX_VOUCHER_MYR } from './voucher-ranges';

// spend_threshold is a lifetime-spend rung, not a payout — the cap only needs
// to reject absurd values, so a generous sanity ceiling (RM 100M) suffices.
const MAX_SPEND_THRESHOLD_MYR = 100_000_000;

// POST /admin/vip-levels body → the full renumbered ladder. Pure cross-row
// validation (contiguity, monotonic thresholds, decade-only frames, non-
// negatives).
export interface VipLevelInput {
  level: number;
  spend_threshold: number;
  voucher_amount: number;
  frame_unlock: boolean;
}

const bad = (m: string): never => {
  throw new MedusaError(MedusaError.Types.INVALID_DATA, m);
};

export function validateVipLevels(raw: unknown): VipLevelInput[] {
  const body = (raw as { levels?: unknown } | null)?.levels;
  if (!Array.isArray(body)) bad('levels must be an array.');
  const rows = body as unknown[];
  if (rows.length < 1) bad('The VIP ladder must have at least 1 level.');

  const out: VipLevelInput[] = [];
  let prevThreshold = -1;
  for (let i = 0; i < rows.length; i++) {
    const r = (rows[i] ?? {}) as Record<string, unknown>;
    const level = i + 1;
    if (r.level !== level)
      bad(
        `level at position ${i} must be ${level} (contiguous 1..N); got ${String(r.level)}.`,
      );

    const threshold = r.spend_threshold;
    if (typeof threshold !== 'number' || !Number.isFinite(threshold))
      bad(`level ${level}: spend_threshold must be a number.`);
    const t = threshold as number;
    if (level === 1 && t !== 0) bad('level 1: spend_threshold must be 0.');
    if (t < 0) bad(`level ${level}: spend_threshold must be >= 0.`);
    if (t > MAX_SPEND_THRESHOLD_MYR)
      bad(
        `level ${level}: spend_threshold must be <= ${MAX_SPEND_THRESHOLD_MYR}.`,
      );
    if (level > 1 && !(t > prevThreshold))
      bad(`level ${level}: spend_threshold must exceed level ${level - 1}'s.`);
    prevThreshold = t;

    const voucher = r.voucher_amount;
    if (
      typeof voucher !== 'number' ||
      !Number.isFinite(voucher) ||
      voucher < 0 ||
      voucher > MAX_VOUCHER_MYR
    )
      bad(
        `level ${level}: voucher_amount must be between 0 and ${MAX_VOUCHER_MYR}.`,
      );

    if (typeof r.frame_unlock !== 'boolean')
      bad(`level ${level}: frame_unlock must be a boolean.`);
    if (
      r.frame_unlock &&
      !(FRAME_LEVELS as readonly number[]).includes(level)
    )
      bad(
        `level ${level}: frame_unlock may only be true on decade levels (10, 20, … 100).`,
      );

    out.push({
      level,
      spend_threshold: t,
      voucher_amount: voucher as number,
      frame_unlock: r.frame_unlock as boolean,
    });
  }
  return out;
}

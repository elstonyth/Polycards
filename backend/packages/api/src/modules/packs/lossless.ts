// Lossless Mode: admin-scheduled windows during which a pack's INSTANT (30s
// reveal) buyback pays 100% (LOSSLESS_PERCENT) instead of its configured rate.
// Pure decision logic only — the rate resolvers and routes read the windows and
// call isLossless/withLossless so quote and credit cannot disagree. The vault
// (FLAT_PERCENT) is never touched.
import { LOSSLESS_PERCENT } from './buyback-rate';
import { FREE_WELCOME_CATEGORY } from './free-pack';

export type LosslessWindow = {
  id: string;
  starts_at: Date | string;
  ends_at: Date | string;
  cancelled_at: Date | string | null;
  /** null = every eligible pack; otherwise only these slugs. */
  pack_slugs: string[] | null;
};

export type LosslessStatus = 'upcoming' | 'live' | 'ended' | 'cancelled';

// Reserved categories that never get lossless: the free welcome pack and reward
// boxes are promo grants, not purchases (no constant exists for reward_box).
export const REWARD_BOX_CATEGORY = 'reward_box';

// Pull source for free rips; task/challenge prizes must not be lifted to 100%.
const EXCLUDED_SOURCE = 'reward';

const ms = (d: Date | string): number => new Date(d).getTime();

/**
 * Epoch ms when the window stops applying: ends_at, or cancelled_at if that is
 * earlier (a cancel ends a live window right away). NaN when a date is
 * unparsable; losslessStatus treats that as 'ended', so the window never
 * matches (fail closed: no accidental 100%).
 */
export function effectiveEndMs(w: LosslessWindow): number {
  const end = ms(w.ends_at);
  return w.cancelled_at == null ? end : Math.min(end, ms(w.cancelled_at));
}

export function losslessStatus(
  w: LosslessWindow,
  nowMs: number,
): LosslessStatus {
  const start = ms(w.starts_at);
  // Cancelled before it ever started: it never ran, so it's "cancelled", not "ended".
  if (w.cancelled_at != null && ms(w.cancelled_at) <= start) return 'cancelled';
  const end = effectiveEndMs(w);
  // `nowMs < NaN` is false, which would fall through to 'live' below — bail first.
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 'ended';
  if (nowMs < start) return 'upcoming';
  return nowMs < end ? 'live' : 'ended';
}

export function packEligible(
  w: LosslessWindow,
  pack: { slug: string; category: string; prize_type?: string | null },
): boolean {
  if (
    pack.category === FREE_WELCOME_CATEGORY ||
    pack.category === REWARD_BOX_CATEGORY ||
    // A spin is never sold back, so there is no buyback to lift.
    pack.prize_type === 'tickets'
  ) {
    return false;
  }
  return w.pack_slugs == null || w.pack_slugs.includes(pack.slug);
}

/** True when `pack` sells at the lossless instant rate at `atMs`. */
export function isLossless(
  windows: LosslessWindow[],
  pack:
    | { slug: string; category: string; prize_type?: string | null }
    | null
    | undefined,
  atMs: number,
  source?: string | null,
): boolean {
  if (!pack || source === EXCLUDED_SOURCE) return false;
  return windows.some(
    (w) => losslessStatus(w, atMs) === 'live' && packEligible(w, pack),
  );
}

/**
 * The pack with its instant rate lifted to LOSSLESS_PERCENT when lossless, else
 * the very same object. Returns a copy — the stored pack is never mutated.
 */
export function withLossless<
  P extends { slug: string; category: string; buyback_percent: unknown },
>(
  pack: P | null | undefined,
  windows: LosslessWindow[],
  atMs: number,
  source?: string | null,
): P | null | undefined {
  return isLossless(windows, pack, atMs, source)
    ? { ...pack!, buyback_percent: LOSSLESS_PERCENT }
    : pack;
}

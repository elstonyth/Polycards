// modules/packs/referral.ts — pure math for the weekly referral engine
// (rebuild, spec docs/superpowers/specs/2026-08-24-referral-tasks-rebuild-design.md).
// No DB, no clock reads (callers pass `now`) so every branch is unit-testable.
//
// The fixed +8h shift is correct ONLY because Asia/Kuala_Lumpur has never
// observed DST — same caveat as ledger.ts ymqInMyt.

export type ReferralTier = { min_cents: number; rate_bp: number };

// Defaults only — the live table is referral_settings.tiers (admin-editable).
// Whole-amount match, NOT marginal brackets: RM20,000 downline turnover pays
// 1.5% on all RM20,000.
export const DEFAULT_REFERRAL_TIERS: ReferralTier[] = [
  { min_cents: 0, rate_bp: 50 }, // RM0+      → 0.5%
  { min_cents: 600_000, rate_bp: 100 }, // RM6,000+  → 1%
  { min_cents: 1_500_000, rate_bp: 150 }, // RM15,000+ → 1.5%
  { min_cents: 3_000_000, rate_bp: 200 }, // RM30,000+ → 2%
];

// A partner's manual rate (customer_account_state.partner_referral_bp)
// REPLACES the tier table outright — it is not a floor or a bonus.
export function resolveRateBp(
  turnoverCents: number,
  tiers: ReferralTier[],
  partnerBp?: number | null,
): number {
  if (partnerBp != null) return partnerBp;
  let rate = 0;
  for (const t of [...tiers].sort((a, b) => a.min_cents - b.min_cents)) {
    if (turnoverCents >= t.min_cents) rate = t.rate_bp;
  }
  return rate;
}

export function payoutCents(basisCents: number, rateBp: number): number {
  return Math.floor((basisCents * rateBp) / 10_000);
}

// Defensive ceiling on ONE line's payout, mirroring MAX_TASK_CREDIT_MYR /
// MAX_BOX_CREDIT_MYR: the tier table and partner bounds both already cap the
// rate, but a bad config (or a compromised admin token) should not be able to
// mint an unbounded credit — the close step refuses to write such a line at
// all (security review 2026-08-25).
export const MAX_SETTLEMENT_LINE_MYR = 50_000;

// How long after a week's end the close must WAIT before snapshotting it. The
// hourly cron fires at the exact boundary, and a pack_open whose transaction
// began a moment before it can still commit after the close's SELECT (READ
// COMMITTED) — the unique week_start then blocks any recompute, so that
// commission is gone for good (review 2026-09). On the `0 * * * *` cron the
// draft therefore lands on the NEXT tick (01:00 MYT, not 00:05); nothing reads
// it in that hour.
export const REFERRAL_CLOSE_GRACE_MS = 5 * 60 * 1000;

// bindReferral's signup window. Attribution binds AT SIGNUP (spec) and the
// storefront fires the bind the moment the account is created, so a customer
// row older than this is not a signup whatever its spend says — the pack_open
// heuristic alone let a months-old, deposited-but-unopened account attach a
// referrer (review 2026-09). adminSetReferral stays the override.
export const REFERRAL_BIND_WINDOW_MS = 24 * 60 * 60 * 1000;

const MYT_OFFSET_MS = 8 * 60 * 60 * 1000; // Asia/Kuala_Lumpur, no DST
const DAY_MS = 24 * 60 * 60 * 1000;

export type ReferralWeek = {
  weekStartIso: string; // 'YYYY-MM-DD' of the MYT anchor day
  startUtc: Date; // anchor 00:00 MYT as a UTC instant (inclusive)
  endUtcExcl: Date; // next anchor 00:00 MYT (exclusive — pair with `<`)
};

// The two cycles deliberately sit on DIFFERENT anchors: money closes on
// Tuesday ("TUES CHECK, WED OUT"), while the /task weekly board resets on
// Monday so the player's week matches the calendar week they think in.
const TUESDAY = 2;
const MONDAY = 1;

// Week containing `at`: the most recent `anchorDay` 00:00 MYT at or before it.
function weekAnchoredOn(at: Date, anchorDay: number): ReferralWeek {
  const myt = new Date(at.getTime() + MYT_OFFSET_MS);
  const day = myt.getUTCDay(); // 0=Sun … 6=Sat (in MYT thanks to the shift)
  const daysSinceAnchor = (day - anchorDay + 7) % 7;
  const anchorMidnightMyt = Date.UTC(
    myt.getUTCFullYear(),
    myt.getUTCMonth(),
    myt.getUTCDate() - daysSinceAnchor,
  );
  const startUtc = new Date(anchorMidnightMyt - MYT_OFFSET_MS);
  return {
    weekStartIso: new Date(anchorMidnightMyt).toISOString().slice(0, 10),
    startUtc,
    endUtcExcl: new Date(startUtc.getTime() + 7 * DAY_MS),
  };
}

/** The settlement week — Tuesday 00:00 MYT. */
export function referralWeekFor(at: Date): ReferralWeek {
  return weekAnchoredOn(at, TUESDAY);
}

/** The /task weekly board's week — Monday 00:00 MYT. */
export function taskWeekFor(at: Date): ReferralWeek {
  return weekAnchoredOn(at, MONDAY);
}

// The most recently ENDED week — what the Tuesday close job settles.
export function lastClosedReferralWeek(now: Date): ReferralWeek {
  const current = referralWeekFor(now);
  return referralWeekFor(new Date(current.startUtc.getTime() - DAY_MS));
}

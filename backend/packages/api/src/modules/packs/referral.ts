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

const MYT_OFFSET_MS = 8 * 60 * 60 * 1000; // Asia/Kuala_Lumpur, no DST
const DAY_MS = 24 * 60 * 60 * 1000;

export type ReferralWeek = {
  weekStartIso: string; // 'YYYY-MM-DD' of the MYT Tuesday
  startUtc: Date; // Tue 00:00 MYT as a UTC instant (inclusive)
  endUtcExcl: Date; // next Tue 00:00 MYT (exclusive — pair with `<`)
};

// Week containing `at`: the most recent Tuesday 00:00 MYT at or before `at`.
export function referralWeekFor(at: Date): ReferralWeek {
  const myt = new Date(at.getTime() + MYT_OFFSET_MS);
  const day = myt.getUTCDay(); // 0=Sun … 2=Tue (in MYT thanks to the shift)
  const daysSinceTue = (day - 2 + 7) % 7;
  const tueMidnightMyt = Date.UTC(
    myt.getUTCFullYear(),
    myt.getUTCMonth(),
    myt.getUTCDate() - daysSinceTue,
  );
  const startUtc = new Date(tueMidnightMyt - MYT_OFFSET_MS);
  return {
    weekStartIso: new Date(tueMidnightMyt).toISOString().slice(0, 10),
    startUtc,
    endUtcExcl: new Date(startUtc.getTime() + 7 * DAY_MS),
  };
}

// The most recently ENDED week — what the Tuesday close job settles.
export function lastClosedReferralWeek(now: Date): ReferralWeek {
  const current = referralWeekFor(now);
  return referralWeekFor(new Date(current.startUtc.getTime() - DAY_MS));
}

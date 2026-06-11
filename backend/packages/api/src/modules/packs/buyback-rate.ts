// Which buyback rate applies to a pull — the single source of truth shared by
// the buyback workflow (what actually gets credited) and the vault route (the
// offer shown). The two must agree or the vault would quote one amount and
// credit another.
//
// Model: a sell-back within the INSTANT WINDOW after the pull gets the pack's
// instant rate (buyback_percent — the "sell on the spot" offer behind the
// 30-second keep/sell countdown at the reveal); after the window — i.e. the
// moment the card sits in the vault/inventory — every sell is at the FLAT
// rate. Time-based so the better rate can't be claimed later by replaying the
// reveal's API call.

export type BuybackRateType = "instant" | "vault";

export type BuybackRate = {
  /** % of current FMV credited (0–100). */
  percent: number;
  rate_type: BuybackRateType;
};

// The site-wide FLAT buyback rate: applied to every sell from the
// vault/inventory, and the floor a pack's instant rate must beat (admin
// validation rejects buyback_percent below it). Also the fallback when the
// source pack was deleted after the pull.
export const FLAT_PERCENT = 90;

// The on-screen keep/sell countdown is 30s, but the server clock starts at
// rolled_at — before the open-pack animation plays — so the window carries
// grace for the animation and network on top of the visible 30s.
const DEFAULT_WINDOW_MS = 90 * 1000;

// Env-tunable like the rate limits; invalid values fall back, never 0 (a 0ms
// window would silently kill the instant rate).
export function instantBuybackWindowMs(): number {
  const raw = process.env.BUYBACK_INSTANT_WINDOW_MS;
  if (raw === undefined || raw === "") return DEFAULT_WINDOW_MS;
  const floored = Math.floor(Number(raw));
  return Number.isSafeInteger(floored) && floored > 0
    ? floored
    : DEFAULT_WINDOW_MS;
}

// FMV × percent in INTEGER CENTS. Money here is USD decimals stored to 2dp
// (Medusa stores prices as-is, never cents), and naive float math misrounds
// exact half-cents (0.15 × 90 = 13.499999999999998 → 13¢ instead of 14¢).
// cents × percent is exact integer arithmetic and a true half after /100 is
// exactly representable in binary, so Math.round always breaks the tie up.
// (The exactness argument assumes an INTEGER percent — guaranteed today by the
// integer buyback_percent column + admin validation's Math.trunc, and
// FLAT_PERCENT is integer. Revisit if fractional rates ever land.)
// The vault quote and the buyback credit MUST both go through this helper —
// they have to agree to the cent.
export function buybackAmount(marketValue: number, percent: number): number {
  const cents = Math.round(marketValue * 100);
  return Math.round((cents * percent) / 100) / 100;
}

const sanePercent = (value: unknown): number | null => {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
};

export function resolveBuybackRate(
  pack: { buyback_percent: unknown } | undefined | null,
  rolledAt: Date | string,
  nowMs: number = Date.now()
): BuybackRate {
  const rolledMs = new Date(rolledAt).getTime();
  // An unparsable rolled_at counts as outside the window — the flat rate is
  // the conservative default.
  const isInstant =
    Number.isFinite(rolledMs) && nowMs - rolledMs <= instantBuybackWindowMs();

  // Floor the instant rate at flat: admin validation enforces >= flat on
  // writes, but legacy rows predating that rule must never make selling now
  // pay less than vaulting would.
  const percent = isInstant
    ? Math.max(sanePercent(pack?.buyback_percent) ?? FLAT_PERCENT, FLAT_PERCENT)
    : FLAT_PERCENT;

  return { percent, rate_type: isInstant ? "instant" : "vault" };
}

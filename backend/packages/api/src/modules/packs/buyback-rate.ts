// Which buyback rate applies to a pull — the single source of truth shared by
// the buyback workflow (what gets credited), the vault route, the reveal route,
// and the open quote. They must agree or the UI would quote one amount and
// credit another.
//
// Model: a sell within the INSTANT WINDOW gets the pack's instant rate
// (buyback_percent — the "sell on the spot" offer behind the 30s keep/sell
// countdown). The window is 30s from the card REVEAL (revealed_at), capped at
// rolled_at + GRACE so a delayed reveal ping can't extend it. Before the ping
// stamps revealed_at (e.g. the open quote, or if the ping fails) it falls back
// to rolled_at + window. After the window, every sell is at the FLAT rate.

export type BuybackRateType = "instant" | "vault";

export type BuybackRate = {
  /** % of current FMV credited (0–100). */
  percent: number;
  rate_type: BuybackRateType;
};

// Site-wide flat buyback rate: every vault sell, the floor a pack's instant
// rate must beat, and the fallback when the source pack was deleted.
export const FLAT_PERCENT = 90;

// Strict 30s instant window, anchored to revealed_at (see header).
const DEFAULT_WINDOW_MS = 30 * 1000;
// Hard ceiling from rolled_at: even a delayed reveal ping cannot push the
// instant window beyond this, so a client can't sit on the pre-card stages then
// ping late to start a fresh 30s arbitrarily far from the pull.
const DEFAULT_REVEAL_GRACE_MS = 5 * 60 * 1000;

// Env-tunable; invalid values fall back, never 0 (a 0ms window would silently
// kill the instant rate).
function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const floored = Math.floor(Number(raw));
  return Number.isSafeInteger(floored) && floored > 0 ? floored : fallback;
}

export const instantWindowMs = (): number =>
  envMs("BUYBACK_INSTANT_WINDOW_MS", DEFAULT_WINDOW_MS);

export const revealGraceMs = (): number =>
  envMs("BUYBACK_REVEAL_GRACE_MS", DEFAULT_REVEAL_GRACE_MS);

/**
 * Epoch ms when the instant rate expires for a pull. Reveal-anchored once the
 * ping has stamped revealed_at; otherwise rolled_at + window (the open quote,
 * before reveal, and the safe default if the ping never lands). Always capped at
 * rolled_at + grace. NaN for an unparsable rolled_at (treated as expired).
 */
export function instantDeadlineMs(
  rolledAt: Date | string,
  revealedAt: Date | string | null | undefined,
): number {
  const rolledMs = new Date(rolledAt).getTime();
  if (!Number.isFinite(rolledMs)) return NaN;
  const cap = rolledMs + revealGraceMs();
  if (revealedAt == null) return Math.min(rolledMs + instantWindowMs(), cap);
  const revealedMs = new Date(revealedAt).getTime();
  if (!Number.isFinite(revealedMs)) {
    return Math.min(rolledMs + instantWindowMs(), cap);
  }
  return Math.min(revealedMs + instantWindowMs(), cap);
}

// value × percent in INTEGER CENTS (naive float misrounds exact half-cents).
// `value` is the MYR display Value (raw USD × FX × markup), NOT raw USD — buyback
// pays MYR credits. The vault quote and the buyback credit MUST both go through
// this helper (on the same MYR value) so a quote can never disagree with a credit.
export function buybackAmount(value: number, percent: number): number {
  const cents = Math.round(value * 100);
  return Math.round((cents * percent) / 100) / 100;
}

const sanePercent = (value: unknown): number | null => {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
};

export function resolveBuybackRate(
  pack: { buyback_percent: unknown } | undefined | null,
  pull: { rolled_at: Date | string; revealed_at?: Date | string | null },
  nowMs: number = Date.now(),
): BuybackRate {
  const deadline = instantDeadlineMs(pull.rolled_at, pull.revealed_at ?? null);
  const isInstant = Number.isFinite(deadline) && nowMs <= deadline;

  // Floor the instant rate at flat: legacy rows predating admin validation must
  // never make selling now pay less than vaulting would.
  const percent = isInstant
    ? Math.max(sanePercent(pack?.buyback_percent) ?? FLAT_PERCENT, FLAT_PERCENT)
    : FLAT_PERCENT;

  return { percent, rate_type: isInstant ? "instant" : "vault" };
}

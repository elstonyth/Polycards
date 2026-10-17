// Bonus credit (泥码) — the spend-only slice of a customer's credit. Pure sen
// math, DB-free like external-funded.ts so the rules are unit-testable. All
// inputs/outputs are integer sen unless the name says Myr. Spec 2026-10-07 §4.
//
// The ledger stamps every row's bonus part in credit_transaction.bonus_cents
// (signed: + adds to the bonus balance, − spends it). An open spends bonus
// FIRST; each pull remembers the share of its price that was bonus
// (pull.bonus_bp). Every sell-back pays NORMAL credit. The bonus-paid share of
// a pull's sale, and the whole sale of the free welcome card, are played
// through once more before they can be withdrawn (operator rule 2026-10-09;
// recordBuybackCreditTransaction). A task / challenge reward's or an admin
// gift pack's sale is cash at once (ADR 0012, sellbackHoldBp).

/** The refusal when a debit other than a pack open would need bonus credit
 *  (delivery fee, withdrawal, admin deduction): the balance covers it, the
 *  normal part does not. */
export const BONUS_NOT_SPENDABLE_MESSAGE =
  "Bonus credit can only be spent on packs — it can't pay for this.";

/** A pull whose whole price was promo value: a gift, the welcome pull, a
 *  reward. */
export const BONUS_BP_FULL = 10_000;

/** Bonus spent by an open of `totalSen`: bonus first, capped both ways. */
export function consumeBonusSen(
  totalSen: number,
  bonusBalanceSen: number,
): number {
  return Math.max(0, Math.min(totalSen, bonusBalanceSen));
}

/** A batch's bonus split over its paid rows in row order (at most one row is
 *  partial), so each pull can carry its own bonus share. */
export function allocateBonusSen(
  priceSen: number,
  rows: number,
  bonusSen: number,
): number[] {
  let left = Math.max(0, bonusSen);
  return Array.from({ length: rows }, () => {
    const take = Math.min(priceSen, left);
    left -= take;
    return take;
  });
}

// Integer ceiling division: rounding always lands on the BONUS side, so a
// rounding error can only keep value locked, never make it withdrawable.
const ceilDiv = (a: number, b: number) => Math.floor((a + b - 1) / b);

/** Share of a row's price paid in bonus, in basis points (rounded up). */
export function bonusBpFor(bonusSen: number, priceSen: number): number {
  if (priceSen <= 0 || bonusSen <= 0) return 0;
  return Math.min(BONUS_BP_FULL, ceilDiv(bonusSen * BONUS_BP_FULL, priceSen));
}

/** One open's bonus share. The free welcome pull is promo value: its whole
 *  sell-back must be played through once (2026-10-11). */
export function openBonusBp(
  free: boolean,
  bonusSen: number,
  priceSen: number,
): number {
  return free ? BONUS_BP_FULL : bonusBpFor(bonusSen, priceSen);
}

/** The `bp` share of a sell-back of `amountSen`, rounded up. Fed
 *  sellbackHoldBp, it is the part to play through. */
export function bonusShareSen(amountSen: number, bp: number): number {
  const clamped = Math.max(0, Math.min(BONUS_BP_FULL, bp));
  if (amountSen <= 0 || clamped === 0) return 0;
  return ceilDiv(amountSen * clamped, BONUS_BP_FULL);
}

export function bonusShareMyr(amount: number, bp: number): number {
  return bonusShareSen(Math.round(amount * 100), bp) / 100;
}

/** The share of a sale held for packs, decided at SELL time (ADR 0012): a
 *  task or weekly-challenge reward (every source 'reward' pull: card and slab
 *  prizes, free rips) and an admin gift pack's pull sell back withdrawable,
 *  so 0; every other pull keeps its bonus_bp, so the welcome pull and
 *  bonus-paid opens still go round twice. */
export function sellbackHoldBp(pull: {
  source?: string | null;
  bonus_bp?: number | null;
}): number {
  return pull.source === 'reward' || pull.source === 'gift'
    ? 0
    : Number(pull.bonus_bp ?? 0);
}

/** Releasing the holds that reward and gift sales stamped before ADR 0012,
 *  once per customer. Only what is still held can go (`remainingSen`: opens
 *  may have spent part of it already), never more than the stamps (the rest
 *  of the hold is top-up money), taken from the newest stamped rows first.
 *  `rows` newest first; returns only rows that change. */
export function releasableRewardHoldSen(input: {
  remainingSen: number;
  rows: { id: string; heldSen: number }[];
}): { id: string; releaseSen: number }[] {
  let left = Math.max(0, input.remainingSen);
  const out: { id: string; releaseSen: number }[] = [];
  for (const row of input.rows) {
    const releaseSen = Math.min(Math.max(0, row.heldSen), left);
    if (releaseSen <= 0) continue;
    out.push({ id: row.id, releaseSen });
    left -= releaseSen;
  }
  return out;
}

/** A paid row is a bonus open when bonus credit paid at least half its price.
 *  Below that it stays 'pack': a few ringgit of leftover bonus must not
 *  disqualify a real-money open from the counts (tasks, achievements, the
 *  welcome unlock, the feed). Leaderboard and challenge value count both
 *  sources in full; bonus_bp still governs money and playthrough. */
export const BONUS_SOURCE_MIN_BP = 5_000;

/** The source of a PAID (not gifted, not free) pull from its bonus share. */
export function paidPullSource(bonusBp: number): 'bonus' | 'pack' {
  return bonusBp >= BONUS_SOURCE_MIN_BP ? 'bonus' : 'pack';
}

// ── SQL fragments ────────────────────────────────────────────────────────────
// One spelling of "the part that is not bonus", so no query that sums money
// can quietly count bonus as cash. Pass the table alias with its dot ('ct.').

/** A credit_transaction row's NORMAL sen, signed like the row. Negate it for
 *  spend: an open's normal spend is `-(normalSenSql())`. */
export const normalSenSql = (t = ''): string =>
  `(ROUND(${t}amount * 100) - COALESCE(${t}bonus_cents, 0))`;

/** Per-reason cash totals: every row's normal part, except a bonus_grant, a
 *  reward_credit (task / challenge prize) or a voucher_claim (VIP voucher) —
 *  bonus since 2026-10-11 — which IS
 *  promo credit with its own bucket — counted whole, never as cash. */
export const reasonCashSenSql = (t = ''): string =>
  `CASE WHEN ${t}reason IN ('bonus_grant', 'reward_credit', 'voucher_claim') THEN ROUND(${t}amount * 100) ELSE ${normalSenSql(t)} END`;

/** Leaderboards count opens paid with normal or bonus credit in full.
 *  Gift, free and reward pulls remain excluded (operator rule 2026-10-17). */
export const LEADERBOARD_PULL_SQL = "pu.source IN ('pack', 'bonus')";

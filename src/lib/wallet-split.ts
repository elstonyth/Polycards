/**
 * The wallet's money split (spec 2026-10-15 §3, final rule):
 * Balance = withdrawable + afterTopup + forPacks, and
 * forPacks = bonus + stillToUse.
 *
 * - forPacks is what can't go to the bank, derived from `withdrawable` rather
 *   than `remaining` so the figures add up even when a delivery fee pushed
 *   `remaining` above the balance. Bonus is capped at it (a frozen account
 *   reads available 0).
 * - afterTopup is only for an account that never topped up: the backend says
 *   withdrawable 0 for all of it, but only the bonus and the stamped sales
 *   (`remaining`) stay for packs — the rest (e.g. unstamped prize or gift
 *   sales) turns withdrawable at the first top-up with no pack opened.
 *
 * Worked in integer sen so float noise never prints; returns RM.
 */
export function walletSplit(w: {
  available: number;
  withdrawable: number;
  bonus: number;
  /** playthrough.remaining — the stamped part still to use on packs. */
  remaining: number;
  hasTopup: boolean;
}): {
  forPacks: number;
  bonus: number;
  stillToUse: number;
  afterTopup: number;
} {
  // Every input is a non-negative amount: NaN or a negative reads as 0.
  const sen = (n: number) =>
    Number.isFinite(n) && n > 0 ? Math.round(n * 100) : 0;
  const raw = Math.max(0, sen(w.available) - sen(w.withdrawable));
  const bonus = Math.min(sen(w.bonus), raw);
  const stillToUse = w.hasTopup
    ? raw - bonus
    : Math.min(sen(w.remaining), raw - bonus);
  return {
    forPacks: (bonus + stillToUse) / 100,
    bonus: bonus / 100,
    stillToUse: stillToUse / 100,
    afterTopup: (raw - bonus - stillToUse) / 100,
  };
}

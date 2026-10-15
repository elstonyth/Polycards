import { rmNbsp } from '@/lib/format';

/** Every money input is a non-negative amount: NaN or a negative reads as 0.
 *  Integer sen, so "is it zero" never trips on float noise. */
export const sen = (n: number) =>
  Number.isFinite(n) && n > 0 ? Math.round(n * 100) : 0;

/**
 * The wallet's money split (spec 2026-10-15 "gate spend first"):
 * Balance = withdrawable + lockedCash + bonus + stillToUse, and
 * forPacks = bonus + stillToUse.
 *
 * - stillToUse is the unspent top-ups and stamped sales (`remaining`), capped
 *   at the non-bonus balance: a delivery fee can push `remaining` above it.
 *   Capped only so the figures add up on screen.
 * - lockedCash ("Withdrawable later") is what turns withdrawable once the
 *   gate opens: the backend reports withdrawable 0 for all of it while the
 *   gate is shut. 0 once anything is withdrawable.
 * - unlockSpend is what packs must still take before the gate opens: bonus
 *   (packs spend it first) plus `remaining`, uncapped.
 *
 * Bonus is capped at the balance (a frozen account reads available 0).
 * Returns RM.
 */
export function walletSplit(w: {
  available: number;
  withdrawable: number;
  bonus: number;
  /** playthrough.remaining — what is still to use on packs. */
  remaining: number;
}): {
  forPacks: number;
  bonus: number;
  stillToUse: number;
  lockedCash: number;
  unlockSpend: number;
} {
  const available = sen(w.available);
  const bonus = Math.min(sen(w.bonus), available);
  const stillToUse = Math.min(sen(w.remaining), available - bonus);
  const lockedCash =
    sen(w.withdrawable) === 0 ? available - bonus - stillToUse : 0;
  return {
    forPacks: (bonus + stillToUse) / 100,
    bonus: bonus / 100,
    stillToUse: stillToUse / 100,
    lockedCash: lockedCash / 100,
    unlockSpend: (sen(w.bonus) + sen(w.remaining)) / 100,
  };
}

/** The backend gate, exactly (withdrawable.ts): topped up, not frozen, money
 *  still to use on packs, so nothing is withdrawable. An older backend that
 *  still pays out part of it (withdrawable > 0) is not locked. */
export function isWithdrawLocked(w: {
  hasTopup: boolean;
  isFrozen: boolean;
  remaining: number;
  withdrawable: number;
}): boolean {
  return (
    w.hasTopup &&
    !w.isFrozen &&
    sen(w.remaining) > 0 &&
    sen(w.withdrawable) === 0
  );
}

/** /me's hint for an account that never topped up. */
export const TOPUP_FIRST_HEADING =
  'Top up and use it on packs to unlock withdrawals';

/** Step 2 of "unlock withdrawals": what packs must take, and why the figure
 *  may be more than the customer expects. */
export function stepTwoCopy(w: {
  hasTopup: boolean;
  available: number;
  bonus: number;
  remaining: number;
}): { title: string; notes: string[] } {
  const bonus = sen(w.bonus);
  const owed = bonus + sen(w.remaining);
  const notes: string[] = [];
  let title: string;
  const bonusNote = `${rmNbsp(bonus / 100)} bonus credit, which packs use first`;
  if (w.hasTopup) {
    title = `Use ${rmNbsp(owed / 100)} more on packs`;
    if (bonus > 0) notes.push(`This includes your ${bonusNote}.`);
  } else {
    title = 'Use your top-up on packs';
    // One line for what is already for packs, so the bonus isn't named twice.
    if (owed > 0 && owed === bonus) notes.push(`Plus your ${bonusNote}.`);
    else if (bonus > 0)
      notes.push(
        `Plus ${rmNbsp(owed / 100)} you already have for packs, including your ${bonusNote}.`,
      );
    else if (owed > 0)
      notes.push(`Plus ${rmNbsp(owed / 100)} you already have for packs.`);
  }
  // A delivery fee took money that was still owed to packs: the figure above
  // is more than the cash left beside the bonus.
  if (sen(w.remaining) > Math.max(0, sen(w.available) - bonus)) {
    notes.push('Delivery fees don’t count as pack spending.');
  }
  return { title, notes };
}

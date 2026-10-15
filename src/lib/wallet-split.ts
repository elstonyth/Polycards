import { rm, rm0 } from '@/lib/format';

/** Every money input is a non-negative amount: NaN or a negative reads as 0. */
const sen = (n: number) =>
  Number.isFinite(n) && n > 0 ? Math.round(n * 100) : 0;

/**
 * The wallet's money split (spec 2026-10-15 "gate spend first"):
 * Balance = withdrawable + lockedCash + bonus + stillToUse, and
 * forPacks = bonus + stillToUse.
 *
 * - stillToUse is the unspent top-ups and stamped sales (`remaining`), capped
 *   at the non-bonus balance: a delivery fee can push `remaining` above it.
 *   Capped only so the figures add up on screen.
 * - lockedCash is what turns withdrawable once the gate opens: the backend
 *   reports withdrawable 0 for all of it while the gate is shut. 0 once
 *   anything is withdrawable — then the backend's figure already holds it.
 * - unlockSpend is what packs must still take before the gate opens: bonus
 *   (packs spend it first) plus `remaining`, uncapped.
 *
 * Bonus is capped at the balance (a frozen account reads available 0). Worked
 * in integer sen so float noise never prints; returns RM.
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
    w.hasTopup && !w.isFrozen && sen(w.remaining) > 0 && !(w.withdrawable > 0)
  );
}

/** The locked line: how much packs must still take, and what the bank gets
 *  after. */
export function unlockLine(w: {
  unlockSpend: number;
  bonus: number;
  lockedCash: number;
}): string {
  return (
    `Spend ${rm(w.unlockSpend)} more on packs to unlock withdrawals` +
    (sen(w.bonus) > 0 ? ' (packs use bonus credit first)' : '') +
    '.' +
    (sen(w.lockedCash) > 0
      ? ` Then ${rm(w.lockedCash)} can go to your bank.`
      : '')
  );
}

/** Never topped up: the heading and body the wallet banner and the withdraw
 *  form's top-up notice share. */
export const TOPUP_FIRST_HEADING =
  'Top up and use it on packs to unlock withdrawals';

export function topupFirstLine(w: {
  depositMinRm: number;
  unlockSpend: number;
  lockedCash: number;
}): string {
  return (
    `Top up once (from ${rm0(w.depositMinRm)}). Then spend your top-up` +
    (sen(w.unlockSpend) > 0 ? ` plus ${rm(w.unlockSpend)}` : '') +
    ' on packs to unlock withdrawals' +
    (sen(w.lockedCash) > 0
      ? `; after that, ${rm(w.lockedCash)} can go to your bank.`
      : '.') +
    ' Card deliveries start after your first top-up.'
  );
}

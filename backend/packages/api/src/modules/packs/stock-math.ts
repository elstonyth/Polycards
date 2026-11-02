// Stock page's "Qty to be procured" (spec 2026-10-28). The boss's formula is
// on hand − (requested + processed) − ready to ship, which is NEGATIVE when
// cards are missing; the operator approved showing that shortfall as a
// positive "need N" and never below 0, so the to-buy list is every N >= 1.
export function toProcure(
  onHand: number,
  requested: number,
  readyToShip: number,
): number {
  return Math.max(0, requested + readyToShip - onHand);
}

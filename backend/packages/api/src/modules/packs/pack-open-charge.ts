// Affordability rule for charging a pack open against the credit ledger
// (Task A2). Pure so the workflow step stays a thin orchestrator.

// Compare in INTEGER SEN: both sides are 2dp RM decimals, and a raw float
// compare would wrongly block a balance that accumulated as 0.1 + 0.2 against
// a 0.3 price (0.30000000000000004 < 0.3 is false, but the reverse trap —
// 2.9999999999999996 vs 3 — blocks a fair open). Rounding to cents first
// makes the comparison exact.
export function hasEnoughCredit(balance: number, price: number): boolean {
  return Math.round(balance * 100) >= Math.round(price * 100);
}

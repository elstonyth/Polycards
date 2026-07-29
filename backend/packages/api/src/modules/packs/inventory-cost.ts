import { fromSen } from './money';

export type CostLine = { qty: number; unit_cost: number };

// Working scale for a line's extended cost: 1/10000 of a ringgit (4dp).
// Deliberately FINER than sen — now DEFENCE IN DEPTH rather than a live
// requirement: api/admin/purchase-invoices/validate.ts caps unit_cost at 2
// decimals, so every persisted line is already whole sen. The finer scale
// stays because quantizing each unit price to a whole sen BEFORE multiplying
// by qty would amplify any sub-sen fraction by the quantity (3 @ 1.006 +
// 1 @ 1.00 reports 1.01 that way, where the true average is 1.0045 -> 1.00),
// and this function takes plain {qty, unit_cost} objects a future caller
// could source from somewhere other than that validator.
const COST_SCALE = 10_000;

// D8: item cost = weighted average of unit_cost across every purchase-invoice
// line for the handle, all invoices, all time — a reversal line's negative
// qty subtracts its own contribution back out, so a full reversal returns
// exactly to "no data" (null), never a division artifact. Integer arithmetic
// (mirrors economy.ts's integer-cent pattern) so float drift can't skew a
// money figure; the result is rounded to sen exactly ONCE, at the very end.
//
// Two "no answer" cases, both reported as null rather than a number:
//   Sigma qty  <= 0  — nothing net on hand; also the division-by-zero guard.
//   Sigma cost <  0  — only reachable from corrupt data (a reversal booked at
//                      a HIGHER unit_cost than the line it undoes, which the
//                      exact card_handle+unit_cost reversal match exists to
//                      prevent). A negative item cost is nonsense for
//                      inventory valuation, so report "unknown" instead of a
//                      confidently-wrong negative figure. `< 0`, not `<= 0`:
//                      genuinely free stock is a real cost of 0.00.
export function weightedAverageCost(lines: CostLine[]): number | null {
  let qtySum = 0;
  let costScaledSum = 0; // Sigma(qty * unit_cost), in 1/10000 ringgit
  for (const line of lines) {
    if (!Number.isFinite(line.qty) || !Number.isFinite(line.unit_cost)) continue;
    qtySum += line.qty;
    // Math.round (not money.ts's toSen) assumes a NON-NEGATIVE unit_cost — it
    // rounds half toward +inf, losing toSen's half-away-from-zero symmetry
    // (-10000.5 -> -10000, not -10001). Unreachable: the model documents
    // unit_cost as always positive, the route validator enforces >= 0, and the
    // sign of a reversal lives in qty.
    costScaledSum += line.qty * Math.round(line.unit_cost * COST_SCALE);
  }
  if (qtySum <= 0 || costScaledSum < 0) return null;
  return fromSen(Math.round(costScaledSum / qtySum / (COST_SCALE / 100)));
}

export default weightedAverageCost;

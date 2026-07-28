import { fromSen } from './money';

export type CostLine = { qty: number; unit_cost: number };

// Working scale for a line's extended cost: 1/10000 of a ringgit (4dp).
// Deliberately FINER than sen. `unit_cost` is only validated "finite and
// >= 0" — there is no decimal-place limit on it — so quantizing each unit
// price to a whole sen BEFORE multiplying by qty would amplify a sub-sen
// fraction by the quantity: 3 @ 1.006 + 1 @ 1.00 reports 1.01 that way, where
// the true average is 1.0045 -> 1.00. Two orders finer than the money this
// reports is enough headroom for that not to bite.
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
    costScaledSum += line.qty * Math.round(line.unit_cost * COST_SCALE);
  }
  if (qtySum <= 0 || costScaledSum < 0) return null;
  return fromSen(Math.round(costScaledSum / qtySum / (COST_SCALE / 100)));
}

export default weightedAverageCost;

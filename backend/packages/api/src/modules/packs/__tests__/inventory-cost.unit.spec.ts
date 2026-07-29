import { weightedAverageCost } from '../inventory-cost';

describe('weightedAverageCost — D8', () => {
  it('is a real weighted average, not a simple mean (10@5.00 + 30@9.00 = 8.00, not 7.00)', () => {
    expect(weightedAverageCost([{ qty: 10, unit_cost: 5 }, { qty: 30, unit_cost: 9 }])).toBe(8);
  });

  it('single line returns unit_cost verbatim', () => {
    expect(weightedAverageCost([{ qty: 5, unit_cost: 8 }])).toBe(8);
  });

  it('a full reversal (Sigma qty === 0) returns null, never NaN/Infinity', () => {
    const r = weightedAverageCost([{ qty: 10, unit_cost: 5 }, { qty: -10, unit_cost: 5 }]);
    expect(r).toBeNull();
  });

  it('a partial reversal nets out correctly (10@5 + 30@9 - 30@9 = 5.00)', () => {
    const r = weightedAverageCost([
      { qty: 10, unit_cost: 5 },
      { qty: 30, unit_cost: 9 },
      { qty: -30, unit_cost: 9 },
    ]);
    expect(r).toBe(5);
  });

  it('an over-reversal (Sigma qty < 0) returns null', () => {
    const r = weightedAverageCost([{ qty: 10, unit_cost: 5 }, { qty: -20, unit_cost: 5 }]);
    expect(r).toBeNull();
  });

  it('no lines at all returns null', () => {
    expect(weightedAverageCost([])).toBeNull();
  });

  it('rounds ONCE at the end, half-up (1@1.00 + 2@1.01 = 100.67 sen -> 1.01)', () => {
    expect(weightedAverageCost([{ qty: 1, unit_cost: 1.0 }, { qty: 2, unit_cost: 1.01 }])).toBe(1.01);
  });

  it('ignores a non-finite line rather than poisoning the whole average', () => {
    expect(
      weightedAverageCost([
        { qty: 10, unit_cost: 5 },
        { qty: NaN, unit_cost: 9 },
      ]),
    ).toBe(5);
  });

  // --- degenerate cases added beyond the brief ---

  // The one case that fails if anyone rewrites the body in naive float
  // arithmetic: (1*0.07 + 1*0.01) / 2 === 0.039999999999999994 in float, so a
  // float implementation returns that instead of 0.04. Integer sen gives
  // (7 + 1) / 2 = 4 sen exactly. This test is why toSen/fromSen are here.
  it('integer-sen arithmetic beats float drift (1@0.07 + 1@0.01 = 0.04)', () => {
    expect(weightedAverageCost([{ qty: 1, unit_cost: 0.07 }, { qty: 1, unit_cost: 0.01 }])).toBe(
      0.04,
    );
  });

  // Sigma qty > 0 but Sigma cost < 0 — only reachable from corrupt data (a
  // reversal booked at a HIGHER unit_cost than the line it undoes, which the
  // exact card_handle+unit_cost reversal match is supposed to prevent).
  // A negative item cost is nonsense for inventory valuation, so report
  // "unknown" rather than a confidently-wrong negative figure.
  it('a positive net qty with a negative net cost returns null, not a negative cost', () => {
    expect(
      weightedAverageCost([
        { qty: 10, unit_cost: 1 },
        { qty: -5, unit_cost: 5 },
      ]),
    ).toBeNull();
  });

  // Free stock is a real cost of 0.00 — it must NOT collapse into the
  // "unknown cost" null, or a promo card reads as un-costed forever.
  it('genuinely free stock reports 0.00, not null', () => {
    expect(weightedAverageCost([{ qty: 4, unit_cost: 0 }])).toBe(0);
  });

  // unit_cost is validated only as "finite and >= 0" — no decimal-place
  // limit — so a sub-sen unit price is a legal, ordinary purchase line.
  // Quantizing each unit price to a whole sen BEFORE multiplying by qty
  // amplifies that fraction by the quantity: this case returns 1.01 that way.
  // True average is (3 * 1.006 + 1 * 1.00) / 4 = 1.0045 -> 1.00.
  it('does not quantize unit_cost to sen before multiplying by qty (3@1.006 + 1@1.00 = 1.00)', () => {
    expect(weightedAverageCost([{ qty: 3, unit_cost: 1.006 }, { qty: 1, unit_cost: 1.0 }])).toBe(1);
  });

  // Same defect, amplified: large offsetting quantities make the per-line
  // sub-sen error dominate. True average is
  // (1000 * 1.005 - 999 * 1.004) / 1 = 2.004 -> 2.00.
  it('sub-sen precision survives large offsetting quantities', () => {
    expect(
      weightedAverageCost([
        { qty: 1000, unit_cost: 1.005 },
        { qty: -999, unit_cost: 1.004 },
      ]),
    ).toBe(2);
  });
});

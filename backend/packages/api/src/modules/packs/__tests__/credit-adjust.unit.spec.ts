import {
  ADJUST_DAILY_MINT_MAX_RM_DEFAULT,
  ADJUST_MAX_RM,
  adjustAmountError,
  adjustDailyMintError,
  adjustNoteError,
} from "../credit-adjust";

// Manual credit adjustment (operator grant/refund/clawback). The amount and
// note rules are pure functions so the workflow step stays a thin
// orchestrator and the rules are testable without a container.

describe("adjustAmountError", () => {
  it("accepts positive and negative 2dp amounts within the cap", () => {
    expect(adjustAmountError(5)).toBeNull();
    expect(adjustAmountError(-5)).toBeNull();
    expect(adjustAmountError(10.5)).toBeNull();
    expect(adjustAmountError(-0.01)).toBeNull();
    expect(adjustAmountError(ADJUST_MAX_RM)).toBeNull();
    expect(adjustAmountError(-ADJUST_MAX_RM)).toBeNull();
  });

  it("accepts 2dp amounts that are not exactly representable in binary", () => {
    // 0.07 * 100 = 7.000000000000001 and -0.29 * 100 = -28.999999999999996 —
    // a naive integer-cents check would wrongly reject both, and the negative
    // keeps sign symmetry on this signed validator. NOT 10.1/-10.1: both are
    // exactly +-1010, so they pass with or without the epsilon and assert
    // nothing.
    expect(adjustAmountError(0.07)).toBeNull();
    expect(adjustAmountError(-0.29)).toBeNull();
  });

  it("rejects zero (an adjustment must move the balance)", () => {
    expect(adjustAmountError(0)).toMatch(/zero/i);
  });

  it("rejects non-finite and non-number values", () => {
    expect(adjustAmountError(NaN)).toMatch(/number/i);
    expect(adjustAmountError(Infinity)).toMatch(/number/i);
    expect(adjustAmountError("50")).toMatch(/number/i);
    expect(adjustAmountError(null)).toMatch(/number/i);
    expect(adjustAmountError(undefined)).toMatch(/number/i);
  });

  it("rejects magnitudes above the cap in both directions", () => {
    expect(adjustAmountError(ADJUST_MAX_RM + 0.01)).toMatch(/at most/i);
    expect(adjustAmountError(-(ADJUST_MAX_RM + 0.01))).toMatch(/at most/i);
  });

  it("rejects sub-cent precision", () => {
    expect(adjustAmountError(1.234)).toMatch(/cent/i);
    expect(adjustAmountError(-0.001)).toMatch(/cent/i);
  });
});

describe("adjustNoteError", () => {
  it("accepts a short operator note", () => {
    expect(adjustNoteError("Goodwill credit for failed open")).toBeNull();
  });

  it("rejects missing, empty, and whitespace-only notes", () => {
    expect(adjustNoteError(undefined)).toMatch(/note/i);
    expect(adjustNoteError(null)).toMatch(/note/i);
    expect(adjustNoteError("")).toMatch(/note/i);
    expect(adjustNoteError("   ")).toMatch(/note/i);
  });

  it("rejects non-string values", () => {
    expect(adjustNoteError(42)).toMatch(/note/i);
    expect(adjustNoteError({})).toMatch(/note/i);
  });

  it("rejects notes longer than 512 chars", () => {
    expect(adjustNoteError("x".repeat(513))).toMatch(/long/i);
    expect(adjustNoteError("x".repeat(512))).toBeNull();
  });
});

// Rolling-24h GLOBAL mint ceiling. The boundary arithmetic is pure so the
// off-by-one that would matter most in production — an adjustment landing
// exactly ON the cap — is pinned without a database.
describe("adjustDailyMintError", () => {
  const CAP = 10_000_00; // RM 10,000 in cents

  it("allows a grant that lands exactly on the ceiling", () => {
    // Strict `>`, not `>=`. With `>=` the default cap (equal to ADJUST_MAX_RM)
    // would refuse the very first max-size grant of the day.
    expect(adjustDailyMintError(0, CAP, CAP)).toBeNull();
    expect(adjustDailyMintError(6_000_00, 4_000_00, CAP)).toBeNull();
  });

  it("refuses the grant that crosses the ceiling by one cent", () => {
    expect(adjustDailyMintError(6_000_00, 4_000_01, CAP)).toMatch(
      /ADJUST_DAILY_MINT_MAX_RM/,
    );
  });

  it("names the env var, the window total, and the remaining headroom", () => {
    const msg = adjustDailyMintError(9_500_00, 1_000_00, CAP);
    expect(msg).toContain("ADJUST_DAILY_MINT_MAX_RM");
    expect(msg).toContain("9500.00"); // already granted in the window
    expect(msg).toContain("500.00"); // remaining today
  });

  it("never reports negative remaining headroom once the window is over cap", () => {
    // Reachable by lowering the env var, or by rows minted under a higher one.
    const msg = adjustDailyMintError(12_000_00, 1_00, CAP);
    expect(msg).toContain("0.00 remaining");
    expect(msg).not.toMatch(/-\d/);
  });

  it("never blocks a clawback, whatever the window holds", () => {
    // Negative adjustments are the operator's way OUT of a bad grant; a mint
    // ceiling that blocked them would trap the money it was meant to bound.
    expect(adjustDailyMintError(50_000_00, -1_00, CAP)).toBeNull();
    expect(adjustDailyMintError(50_000_00, -50_000_00, 0)).toBeNull();
    expect(adjustDailyMintError(0, 0, 0)).toBeNull();
  });

  it("refuses every positive grant when the cap is 0 (incident stop lever)", () => {
    expect(adjustDailyMintError(0, 1, 0)).toMatch(/ADJUST_DAILY_MINT_MAX_RM/);
  });

  it("defaults to one full-size per-call grant per day", () => {
    // The default equals ADJUST_MAX_RM: one max grant passes, a second does not.
    const cap = ADJUST_DAILY_MINT_MAX_RM_DEFAULT * 100;
    expect(ADJUST_DAILY_MINT_MAX_RM_DEFAULT).toBe(ADJUST_MAX_RM);
    expect(adjustDailyMintError(0, ADJUST_MAX_RM * 100, cap)).toBeNull();
    expect(
      adjustDailyMintError(ADJUST_MAX_RM * 100, ADJUST_MAX_RM * 100, cap),
    ).toMatch(/ADJUST_DAILY_MINT_MAX_RM/);
  });
});

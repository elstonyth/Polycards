import {
  FLAT_PERCENT,
  buybackAmount,
  instantDeadlineMs,
  instantWindowMs,
  revealGraceMs,
  resolveBuybackRate,
} from "../buyback-rate";

const NOW = 1_750_000_000_000;
const ago = (ms: number) => new Date(NOW - ms);

describe("instantDeadlineMs", () => {
  it("falls back to rolled_at + window when not yet revealed", () => {
    expect(instantDeadlineMs(ago(0), null)).toBe(NOW + instantWindowMs());
  });

  it("anchors to revealed_at + window once revealed", () => {
    // rolled 60s ago, revealed 5s ago → deadline is 25s from now
    expect(instantDeadlineMs(ago(60_000), ago(5_000))).toBe(
      NOW - 5_000 + instantWindowMs(),
    );
  });

  it("never exceeds rolled_at + grace, even for a late reveal", () => {
    const rolled = ago(revealGraceMs() - 1_000); // grace nearly elapsed
    const revealedNow = new Date(NOW);
    expect(instantDeadlineMs(rolled, revealedNow)).toBe(
      rolled.getTime() + revealGraceMs(),
    );
  });

  it("returns NaN for an unparsable rolled_at", () => {
    expect(Number.isNaN(instantDeadlineMs("nope", null))).toBe(true);
  });
});

describe("resolveBuybackRate", () => {
  const pack = { buyback_percent: 95 };

  it("credits the pack rate inside the reveal window", () => {
    expect(
      resolveBuybackRate(pack, { rolled_at: ago(60_000), revealed_at: ago(5_000) }, NOW),
    ).toEqual({ percent: 95, rate_type: "instant" });
  });

  it("uses the rolled_at fallback window before reveal", () => {
    expect(
      resolveBuybackRate(pack, { rolled_at: ago(1_000), revealed_at: null }, NOW),
    ).toEqual({ percent: 95, rate_type: "instant" });
  });

  it("forces the FLAT vault rate once the instant window is CLOSED, even inside the 30s", () => {
    // The reveal was left / concluded (close-on-leave): the pull is still well
    // within its time window, but instant_closed_at ends the premium for good.
    expect(
      resolveBuybackRate(
        pack,
        {
          rolled_at: ago(5_000),
          revealed_at: ago(5_000),
          instant_closed_at: ago(1_000),
        },
        NOW,
      ),
    ).toEqual({ percent: FLAT_PERCENT, rate_type: "vault" });
  });

  it("still credits the pack rate while the window is OPEN (instant_closed_at null)", () => {
    expect(
      resolveBuybackRate(
        pack,
        { rolled_at: ago(5_000), revealed_at: ago(5_000), instant_closed_at: null },
        NOW,
      ),
    ).toEqual({ percent: 95, rate_type: "instant" });
  });

  it("floors a below-flat pack rate at the flat rate inside the window", () => {
    expect(
      resolveBuybackRate({ buyback_percent: 80 }, { rolled_at: ago(1_000) }, NOW),
    ).toEqual({ percent: FLAT_PERCENT, rate_type: "instant" });
  });

  it("falls back to flat when the pack is gone or the rate is invalid", () => {
    expect(
      resolveBuybackRate(null, { rolled_at: ago(1_000) }, NOW).percent,
    ).toBe(FLAT_PERCENT);
    expect(
      resolveBuybackRate({ buyback_percent: 250 }, { rolled_at: ago(1_000) }, NOW)
        .percent,
    ).toBe(FLAT_PERCENT);
  });

  it("credits the FLAT vault rate after the reveal window", () => {
    expect(
      resolveBuybackRate(
        pack,
        { rolled_at: ago(120_000), revealed_at: ago(instantWindowMs() + 1) },
        NOW,
      ),
    ).toEqual({ percent: FLAT_PERCENT, rate_type: "vault" });
  });

  it("credits the FLAT vault rate past the grace cap even if revealed late", () => {
    expect(
      resolveBuybackRate(
        pack,
        { rolled_at: ago(revealGraceMs() + 1), revealed_at: new Date(NOW) },
        NOW,
      ),
    ).toEqual({ percent: FLAT_PERCENT, rate_type: "vault" });
  });

  it("treats an unparsable rolled_at as outside the window (flat rate)", () => {
    expect(
      resolveBuybackRate(pack, { rolled_at: "not-a-date" }, NOW),
    ).toEqual({ percent: FLAT_PERCENT, rate_type: "vault" });
  });
});

describe("buybackAmount", () => {
  it("computes FMV × percent to whole cents", () => {
    expect(buybackAmount(21.99, 92)).toBe(20.23);
    expect(buybackAmount(19.2, 100)).toBe(19.2);
    expect(buybackAmount(0, 90)).toBe(0);
  });

  it("rounds an exact half-cent up, where naive float math rounds down", () => {
    expect(buybackAmount(0.15, 90)).toBe(0.14);
    expect(buybackAmount(2.45, 90)).toBe(2.21);
    expect(buybackAmount(0.05, 90)).toBe(0.05);
  });

  it("returns whole cents within half a cent of the exact product, across the input space", () => {
    // Implementation-independent contract (NOT the formula restated): every
    // result is a whole number of cents, and never further than half a cent
    // from the mathematically exact FMV × percent.
    for (let cents = 0; cents <= 5000; cents += 7) {
      const fmv = cents / 100;
      for (const pct of [90, 92, 95, 100]) {
        const result = buybackAmount(fmv, pct);
        const resultCents = result * 100;
        expect(Math.abs(resultCents - Math.round(resultCents))).toBeLessThan(1e-9);
        expect(Math.abs(result - (fmv * pct) / 100)).toBeLessThanOrEqual(0.005 + 1e-9);
      }
    }
  });
});

describe("instantWindowMs", () => {
  const KEY = "BUYBACK_INSTANT_WINDOW_MS";
  const saved = process.env[KEY];
  afterEach(() => {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
  });

  it("defaults to a strict 30s", () => {
    delete process.env[KEY];
    expect(instantWindowMs()).toBe(30_000);
  });

  it("honors a valid env override and rejects invalid ones", () => {
    process.env[KEY] = "5000";
    expect(instantWindowMs()).toBe(5_000);
    process.env[KEY] = "0";
    expect(instantWindowMs()).toBe(30_000);
    process.env[KEY] = "soon";
    expect(instantWindowMs()).toBe(30_000);
  });
});

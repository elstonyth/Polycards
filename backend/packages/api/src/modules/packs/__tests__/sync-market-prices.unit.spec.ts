import {
  refreshCardPrice,
  MAX_MARKET_VALUE_USD,
  MAX_SYNC_DELTA_RATIO,
  type CardRow,
} from "../sync-market-prices";

const card = (over: Partial<CardRow>): CardRow => ({
  id: "card_1",
  handle: "test-card",
  pc_product_id: "6910",
  pc_grade: "PSA 10",
  market_value: 150,
  ...over,
});

const deps = (pennies: number) => {
  const updates: unknown[] = [];
  return {
    updates,
    d: {
      pcFetch: async () => ({
        kind: "ok" as const,
        data: { "manual-only-price": pennies },
      }),
      updateCards: async (u: unknown) => void updates.push(u),
      now: new Date(),
    },
  };
};

test("updates from tier price", async () => {
  const upd: any[] = [];
  const testCard = {
    id: "c1",
    handle: "charizard-psa-10",
    pc_product_id: "6910",
    pc_grade: "PSA 10",
    market_value: 100,
  };
  const r = await refreshCardPrice(testCard as any, {
    pcFetch: async () => ({ kind: "ok", data: { "manual-only-price": 15000 } }),
    updateCards: async (u: any) => {
      upd.push(u[0]);
    },
    now: new Date("2026-07-01T00:00:00Z"),
  });
  expect(r.newValue).toBe(150);
  expect(r.changed).toBe(true);
  expect(upd[0].market_value).toBe(150);
});

test("keeps last-known on error", async () => {
  const testCard = {
    id: "c1",
    handle: "charizard-psa-10",
    pc_product_id: "6910",
    pc_grade: "PSA 10",
    market_value: 100,
  };
  const r = await refreshCardPrice(testCard as any, {
    pcFetch: async () => ({ kind: "error", message: "boom" }),
    updateCards: async () => {
      throw new Error("no write");
    },
    now: new Date("2026-07-01T00:00:00Z"),
  });
  expect(r.changed).toBe(false);
  expect(r.skippedReason).toBe("boom");
});

test("skips zero price", async () => {
  const testCard = {
    id: "c1",
    handle: "charizard-psa-10",
    pc_product_id: "6910",
    pc_grade: "PSA 10",
    market_value: 100,
  };
  const r = await refreshCardPrice(testCard as any, {
    pcFetch: async () => ({ kind: "ok", data: { "manual-only-price": 0 } }),
    updateCards: async () => {
      throw new Error("no write");
    },
    now: new Date("2026-07-01T00:00:00Z"),
  });
  expect(r.changed).toBe(false);
  expect(r.skippedReason).toMatch(/no usable price/i);
});

describe("refreshCardPrice — sanity bounds", () => {
  it("skips a change beyond MAX_SYNC_DELTA_RATIO and keeps last-known", async () => {
    const { d, updates } = deps(950 * 100); // $150 -> $950 (6.33×, beyond 5×)
    const r = await refreshCardPrice(card({}), d);
    expect(r.skippedReason).toMatch(/anomalous/);
    expect(r.newValue).toBe(150);
    expect(updates).toHaveLength(0);
  });

  it("skips a crash below 1/MAX_SYNC_DELTA_RATIO", async () => {
    const { d, updates } = deps(2500); // $150 -> $25 (0.167×, below 1/5)
    const r = await refreshCardPrice(card({}), d);
    expect(r.skippedReason).toMatch(/anomalous/);
    expect(updates).toHaveLength(0);
  });

  it("accepts a change within the ratio", async () => {
    const { d, updates } = deps(450 * 100); // 3× — within 5×
    const r = await refreshCardPrice(card({}), d);
    expect(r.changed).toBe(true);
    expect(r.newValue).toBe(450);
    expect(updates).toHaveLength(1);
  });

  it("caps first-sync values at MAX_MARKET_VALUE_USD", async () => {
    const { d, updates } = deps((MAX_MARKET_VALUE_USD + 1) * 100);
    const r = await refreshCardPrice(card({ market_value: 0 }), d);
    expect(r.skippedReason).toMatch(/cap/);
    expect(updates).toHaveLength(0);
  });

  it("sanity: ratio constant is what buyback exposure was priced against", () => {
    expect(MAX_SYNC_DELTA_RATIO).toBeGreaterThanOrEqual(2);
  });
});

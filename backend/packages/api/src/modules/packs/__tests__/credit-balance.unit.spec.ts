import PacksModuleService from "../service";

// creditBalance/creditSummary now run ONE SQL aggregate (Postgres sums the
// ledger in integer cents) instead of paging + folding in JS — see
// service.ts's creditSummary and credit-summary.ts's doc comment. The
// Postgres-side arithmetic itself is proven against the pure fold by the
// "creditSummary — SQL matches the unit-tested fold" integration test
// (pull-status-transitions.spec.ts). What's left to unit-test here, without a
// DB, is the JS-side edge of that boundary: converting the aggregate's bigint
// cent strings back to exact MYR decimals, and the empty-ledger default.

type FakeRow = {
  balance_cents: string | null;
  topup_cents: string | null;
  spend_cents: string | null;
  ext_spend_cents: string | null;
  vip_spend_cents: string | null;
  deposited_pt_cents: string | null;
};

/** Fake service: @InjectManager reads `sharedContext.manager` when present
 *  (it only falls back to `this.baseRepository_.getFreshManager()` if the
 *  context didn't supply one), so a bare `{ manager }` context is enough to
 *  drive `creditSummary` without a real DB connection. */
const fakeService = (row: FakeRow | undefined) => {
  const calls: Array<unknown[] | undefined> = [];
  const svc = Object.create(
    PacksModuleService.prototype
  ) as PacksModuleService;
  const manager = {
    execute: async (_query: string, params?: unknown[]) => {
      calls.push(params);
      return row ? [row] : [];
    },
  };
  return { svc, manager, calls };
};

describe("PacksModuleService.creditSummary (SQL aggregate)", () => {
  it("returns all zeros for an empty ledger (no aggregate row)", async () => {
    const { svc, manager } = fakeService(undefined);
    expect(await svc.creditSummary("cus_1", { manager })).toEqual({
      balance: 0,
      topupTotal: 0,
      spendTotal: 0,
      externalFundedSpendTotal: 0,
      vipSpendTotal: 0,
      depositedPlaythroughTotal: 0,
    });
  });

  it("converts bigint cent strings to exact MYR (no float drift)", async () => {
    const { svc, manager } = fakeService({
      balance_cents: "2053",
      topup_cents: "10000",
      spend_cents: "7947",
      ext_spend_cents: "500",
      vip_spend_cents: "7947",
      deposited_pt_cents: "8000",
    });
    expect(await svc.creditSummary("cus_1", { manager })).toEqual({
      balance: 20.53,
      topupTotal: 100,
      spendTotal: 79.47,
      externalFundedSpendTotal: 5,
      vipSpendTotal: 79.47,
      depositedPlaythroughTotal: 80,
    });
  });

  it("holds exact for a large ledger's aggregated bigint sum", async () => {
    // 3000 rows × 1 cent, summed in Postgres as bigint '3000000' — the
    // pre-SQL suite's "no drift across many small rows" case, moved to the
    // DB side; the JS side must still land on exactly 30000, not 29999.999….
    const { svc, manager } = fakeService({
      balance_cents: "3000000",
      topup_cents: "0",
      spend_cents: "0",
      ext_spend_cents: "0",
      vip_spend_cents: "0",
      deposited_pt_cents: "0",
    });
    expect((await svc.creditSummary("cus_1", { manager })).balance).toBe(
      30000
    );
  });

  it("passes the customerId through as the SQL parameter", async () => {
    const { svc, manager, calls } = fakeService({
      balance_cents: "0",
      topup_cents: "0",
      spend_cents: "0",
      ext_spend_cents: "0",
      vip_spend_cents: "0",
      deposited_pt_cents: "0",
    });
    await svc.creditSummary("cus_42", { manager });
    expect(calls[0]).toEqual(["cus_42"]);
  });

  // creditBalance itself takes no context param (unchanged signature) and
  // resolves its manager from `this.baseRepository_`, so exercising its
  // delegation to creditSummary needs a real DB container — covered by the
  // integration suites (e.g. reverse-open.spec.ts, vault-buyback.spec.ts).
});

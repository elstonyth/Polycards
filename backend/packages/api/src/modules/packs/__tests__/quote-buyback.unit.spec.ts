import PacksModuleService from "../service";

const NOW = 1_750_000_000_000;
function fakePacks(pack: unknown) {
  const svc = Object.create(PacksModuleService.prototype) as PacksModuleService;
  (svc as unknown as { listPacks: unknown }).listPacks = async () =>
    pack ? [pack] : [];
  return svc;
}

describe("quoteBuyback", () => {
  it("quotes the instant offer for a fresh pull", async () => {
    const packs = fakePacks({ slug: "p1", buyback_percent: 99 });
    const q = await packs.quoteBuyback("p1", new Date(NOW - 1000), 0.15, NOW);
    expect(q).toEqual({
      percent: 99,
      amount: Math.round((Math.round(0.15 * 100) * 99) / 100) / 100,
      rate_type: "instant",
    });
  });
  it("flat-floors the rate when the pack is gone (still inside the window)", async () => {
    const packs = fakePacks(null);
    const q = await packs.quoteBuyback("gone", new Date(NOW - 1000), 1, NOW);
    expect(q.rate_type).toBe("instant");
    expect(q.amount).toBe(Math.round((100 * q.percent) / 100) / 100);
  });
});

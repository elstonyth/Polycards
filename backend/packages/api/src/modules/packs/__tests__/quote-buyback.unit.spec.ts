import PacksModuleService from "../service";
import type { LosslessWindow } from "../lossless";

const NOW = 1_750_000_000_000;
function fakePacks(pack: unknown, windows: LosslessWindow[] = []) {
  const svc = Object.create(PacksModuleService.prototype) as PacksModuleService;
  (svc as unknown as { listPacks: unknown }).listPacks = async () =>
    pack ? [pack] : [];
  (svc as unknown as { losslessWindows: unknown }).losslessWindows = async () =>
    windows;
  return svc;
}

describe("quoteBuyback", () => {
  it("quotes the instant offer for a fresh pull", async () => {
    const packs = fakePacks({ slug: "p1", buyback_percent: 99 });
    const q = await packs.quoteBuyback("p1", { rolled_at: new Date(NOW - 1000) }, 0.15, NOW);
    expect(q).toEqual({
      percent: 99,
      amount: Math.round((Math.round(0.15 * 100) * 99) / 100) / 100,
      rate_type: "instant",
    });
  });
  it("flat-floors the rate when the pack is gone (still inside the window)", async () => {
    const packs = fakePacks(null);
    const q = await packs.quoteBuyback("gone", { rolled_at: new Date(NOW - 1000) }, 1, NOW);
    expect(q.rate_type).toBe("instant");
    expect(q.amount).toBe(Math.round((100 * q.percent) / 100) / 100);
  });
  it("lifts to 100 when the pull was rolled inside a live Lossless window, never for a reward pull", async () => {
    const live: LosslessWindow = {
      id: "lw1",
      starts_at: new Date(NOW - 60_000),
      ends_at: new Date(NOW + 60_000),
      cancelled_at: null,
      pack_slugs: null,
    };
    const packs = fakePacks(
      { slug: "p1", category: "pokemon", buyback_percent: 90 },
      [live],
    );
    const pull = { rolled_at: new Date(NOW - 1000) };
    expect(await packs.quoteBuyback("p1", pull, 2, NOW)).toEqual({
      percent: 100,
      amount: 2,
      rate_type: "instant",
    });
    expect((await packs.quoteBuyback("p1", pull, 2, NOW, "reward")).percent).toBe(90);
  });
  it("decides on preloaded windows without reading them again (open-batch)", async () => {
    const live: LosslessWindow = {
      id: "lw1",
      starts_at: new Date(NOW - 60_000),
      ends_at: new Date(NOW + 60_000),
      cancelled_at: null,
      pack_slugs: null,
    };
    const packs = fakePacks({ slug: "p1", category: "pokemon", buyback_percent: 90 });
    const read = jest.fn();
    (packs as unknown as { losslessWindows: unknown }).losslessWindows = read;
    const pull = { rolled_at: new Date(NOW - 1000) };
    expect(
      (await packs.quoteBuyback("p1", pull, 2, NOW, "pack", [live])).percent,
    ).toBe(100);
    expect(read).not.toHaveBeenCalled();
  });
});

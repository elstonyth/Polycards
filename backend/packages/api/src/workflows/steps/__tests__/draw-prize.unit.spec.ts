import type { MedusaContainer } from "@medusajs/framework/types";
import { Modules, ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { drawPrize } from "../draw-prize";

// B4 — drawPrize unit tests.
// Pure pick + product resolution; writes no rows.
// Container is mocked with only the modules drawPrize touches.

type OddsRow = {
  id: string;
  weight: number;
  kind: "product" | "credit" | "nothing";
  product_handle?: string | null;
  credit_amount?: number | null;
};

function buildContainer(overrides?: {
  listProducts?: jest.Mock;
  listInventoryItems?: jest.Mock;
  /** stock map: handle → available qty (null = untracked = infinite) */
  stockByHandle?: Map<string, number | null>;
}): MedusaContainer {
  const listProducts =
    overrides?.listProducts ??
    jest.fn().mockResolvedValue([
      { handle: "p-x", title: "Prize Card X", thumbnail: "/img/p-x.webp" },
    ]);

  // Query stub for stock checks: returns data with handle + stock info.
  // If stockByHandle provided, simulate queryStockRows-compatible payload.
  const stockByHandle = overrides?.stockByHandle;
  const queryGraph = jest.fn().mockImplementation(
    ({ filters }: { entity: string; filters: { handle: string[] } }) => {
      if (!stockByHandle) {
        // Default: all products have stock
        return Promise.resolve({
          data: filters.handle.map((h) => ({
            handle: h,
            variants: [
              {
                manage_inventory: true,
                inventory_items: [
                  {
                    inventory: {
                      id: `inv_${h}`,
                      location_levels: [
                        { location_id: "loc_1", stocked_quantity: 10, reserved_quantity: 0 },
                      ],
                    },
                  },
                ],
              },
            ],
          })),
        });
      }
      return Promise.resolve({
        data: filters.handle
          .filter((h) => stockByHandle.has(h))
          .map((h) => {
            const qty = stockByHandle.get(h);
            if (qty === null) {
              // untracked = no manage_inventory
              return { handle: h, variants: [{ manage_inventory: false, inventory_items: [] }] };
            }
            return {
              handle: h,
              variants: [
                {
                  manage_inventory: true,
                  inventory_items: [
                    {
                      inventory: {
                        id: `inv_${h}`,
                        location_levels: [
                          { location_id: "loc_1", stocked_quantity: qty, reserved_quantity: 0 },
                        ],
                      },
                    },
                  ],
                },
              ],
            };
          }),
      });
    }
  );

  const modules: Record<string, unknown> = {
    [Modules.PRODUCT]: { listProducts },
    [ContainerRegistrationKeys.QUERY]: { graph: queryGraph },
    [ContainerRegistrationKeys.LOGGER]: { warn: jest.fn() },
  };
  return {
    resolve: (key: string) => {
      if (!(key in modules)) {
        throw new Error(`unit stub: unexpected container.resolve("${key}")`);
      }
      return modules[key];
    },
  } as unknown as MedusaContainer;
}

describe("drawPrize (B4)", () => {
  beforeEach(() => {
    jest.spyOn(Math, "random").mockReturnValue(0); // deterministic: always pick first row
  });
  afterEach(() => {
    (Math.random as jest.Mock).mockRestore?.();
    jest.restoreAllMocks();
  });

  it("credit row → {kind:'credit', amount_myr:5}", async () => {
    const odds: OddsRow[] = [{ id: "o1", weight: 1, kind: "credit", credit_amount: 5 }];
    const container = buildContainer();
    const prize = await drawPrize(container, odds);
    expect(prize).toEqual({ kind: "credit", amount_myr: 5 });
  });

  it("nothing row → {kind:'nothing'}", async () => {
    const odds: OddsRow[] = [{ id: "o1", weight: 1, kind: "nothing" }];
    const container = buildContainer();
    const prize = await drawPrize(container, odds);
    expect(prize).toEqual({ kind: "nothing" });
  });

  it("product row → resolves title+thumbnail from Modules.PRODUCT", async () => {
    const listProducts = jest.fn().mockResolvedValue([
      { handle: "p-x", title: "Prize Card X", thumbnail: "/img/p-x.webp" },
    ]);
    const odds: OddsRow[] = [{ id: "o1", weight: 1, kind: "product", product_handle: "p-x" }];
    const container = buildContainer({ listProducts });
    const prize = await drawPrize(container, odds);
    expect(prize).toEqual({
      kind: "product",
      product_handle: "p-x",
      title: "Prize Card X",
      image: "/img/p-x.webp",
    });
    expect(listProducts).toHaveBeenCalledWith(
      { handle: "p-x" },
      expect.objectContaining({ fields: expect.arrayContaining(["title", "thumbnail"]) })
    );
  });

  it("product row with 0 stock is dropped → falls through to nothing-equivalent (no survivors)", async () => {
    // Only one product entry, and it has 0 stock → survivors empty.
    // drawPrize should not throw — returns {kind:'nothing'} when all product entries are gated out
    // and no other entries exist.
    const odds: OddsRow[] = [{ id: "o1", weight: 1, kind: "product", product_handle: "p-x" }];
    const stockByHandle = new Map<string, number | null>([["p-x", 0]]);
    const container = buildContainer({ stockByHandle });
    const prize = await drawPrize(container, odds);
    // No survivors → nothing
    expect(prize).toEqual({ kind: "nothing" });
  });

  it("product row with untracked stock (null) passes through (infinite stock)", async () => {
    const listProducts = jest.fn().mockResolvedValue([
      { handle: "p-y", title: "Untracked Prize", thumbnail: "/img/p-y.webp" },
    ]);
    const odds: OddsRow[] = [{ id: "o1", weight: 1, kind: "product", product_handle: "p-y" }];
    const stockByHandle = new Map<string, number | null>([["p-y", null]]);
    const container = buildContainer({ listProducts, stockByHandle });
    const prize = await drawPrize(container, odds);
    expect(prize).toEqual({
      kind: "product",
      product_handle: "p-y",
      title: "Untracked Prize",
      image: "/img/p-y.webp",
    });
  });

  it("mixed pool: product with stock + credit; Math.random=0 → product (first row)", async () => {
    const listProducts = jest.fn().mockResolvedValue([
      { handle: "p-z", title: "Prize Z", thumbnail: "/img/p-z.webp" },
    ]);
    const odds: OddsRow[] = [
      { id: "o1", weight: 1, kind: "product", product_handle: "p-z" },
      { id: "o2", weight: 1, kind: "credit", credit_amount: 10 },
    ];
    const container = buildContainer({ listProducts });
    const prize = await drawPrize(container, odds);
    expect(prize.kind).toBe("product");
  });
});

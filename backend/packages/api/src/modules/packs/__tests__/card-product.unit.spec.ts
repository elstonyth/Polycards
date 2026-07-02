import { ProductStatus } from "@medusajs/framework/utils";
import { buildCardProductInput } from "../card-product";

const baseSeed = {
  handle: "test-card",
  title: "Test Card",
  image: "/x.webp",
  price: 10,
  metadata: {
    fmv: 10,
    points: 0,
    grade: "10",
    grader: "PSA",
    set: "S",
    year: 2026,
  },
};

const opts = {
  shippingProfileId: "sp_1",
  salesChannelId: "sc_1",
  status: ProductStatus.PUBLISHED,
  manageInventory: true,
};

test("omits PriceCharting metadata and tracks inventory when not provided", () => {
  const input = buildCardProductInput(baseSeed, opts);
  expect(input.metadata).not.toHaveProperty("pc_product_id");
  expect(input.metadata).not.toHaveProperty("pc_grade");
  expect(input.metadata).not.toHaveProperty("market_multiplier");
  expect(input.variants?.[0]?.manage_inventory).toBe(true);
});

test("includes PriceCharting metadata when provided", () => {
  const input = buildCardProductInput(
    {
      ...baseSeed,
      metadata: {
        ...baseSeed.metadata,
        pc_product_id: "pc_9",
        pc_grade: "PSA 10",
        market_multiplier: 1.2,
      },
    },
    opts,
  );
  expect(input.metadata).toMatchObject({
    pc_product_id: "pc_9",
    pc_grade: "PSA 10",
    market_multiplier: 1.2,
  });
});

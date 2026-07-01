import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { MedusaError } from "@medusajs/framework/utils";
import { createProductFromPriceChartingWorkflow } from "../../../../workflows/create-product-from-pricecharting";

type Body = {
  pc_product_id?: unknown;
  pc_grade?: unknown;
  name?: unknown;
  set?: unknown;
  grader?: unknown;
  grade?: unknown;
  market_value?: unknown;
  image?: unknown;
  price?: unknown;
  for_sale?: unknown;
  market_multiplier?: unknown;
};

const requireString = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.trim() === "") {
    throw new MedusaError(MedusaError.Types.INVALID_DATA, `'${field}' is required.`);
  }
  return value;
};

const requireNonNegativeNumber = (value: unknown, field: string): number => {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `'${field}' must be a non-negative number.`,
    );
  }
  return n;
};

// POST /admin/products/from-pricecharting — mint a standalone marketplace
// Product from a PriceCharting lookup, carrying the PC link on
// product.metadata. NO card is created here.
export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const body = req.body as Body;

  const pc_product_id = requireString(body.pc_product_id, "pc_product_id");
  const pc_grade = requireString(body.pc_grade, "pc_grade");
  const name = requireString(body.name, "name");
  const market_value = requireNonNegativeNumber(body.market_value, "market_value");
  const image = requireString(body.image, "image");

  const set = typeof body.set === "string" ? body.set : "";
  const grader = typeof body.grader === "string" ? body.grader : "";
  const grade = typeof body.grade === "string" ? body.grade : "";
  const price =
    body.price === null || body.price === undefined
      ? null
      : requireNonNegativeNumber(body.price, "price");
  const for_sale = typeof body.for_sale === "boolean" ? body.for_sale : undefined;
  const market_multiplier =
    body.market_multiplier === undefined
      ? 1.2
      : requireNonNegativeNumber(body.market_multiplier, "market_multiplier");

  const { result } = await createProductFromPriceChartingWorkflow(req.scope).run({
    input: {
      pc_product_id,
      pc_grade,
      name,
      set,
      grader,
      grade,
      market_value,
      image,
      price,
      for_sale,
      market_multiplier,
    },
  });

  res.status(201).json({ product: { id: result.id, handle: result.handle } });
}

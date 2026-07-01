import { createWorkflow, WorkflowResponse } from "@medusajs/framework/workflows-sdk";
import {
  createProductFromPcStep,
  type CreateProductFromPcInput,
} from "./steps/create-product-from-pricecharting";

export type { CreateProductFromPcInput };

// create-product-from-pricecharting — mint a standalone marketplace Product
// from a PriceCharting lookup, carrying the PC link on product.metadata.
// NO card is created here (see create-card for that separate step).
export const createProductFromPriceChartingWorkflow = createWorkflow(
  "create-product-from-pricecharting",
  (input: CreateProductFromPcInput) => {
    const result = createProductFromPcStep(input);
    return new WorkflowResponse(result);
  },
);

export default createProductFromPriceChartingWorkflow;

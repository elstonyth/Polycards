import {
  createWorkflow,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk";
import { createCardStep, type CardWriteInput } from "./steps/create-card";

// create-card — create a gacha Card and its mirrored marketplace Product.
// Single compensated step today; the pure composition body leaves room to append
// an audit/event step without risking a half-applied create.
export const createCardWorkflow = createWorkflow(
  "create-card",
  function (input: CardWriteInput) {
    const result = createCardStep(input);
    return new WorkflowResponse(result);
  }
);

export default createCardWorkflow;

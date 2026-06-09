import {
  createWorkflow,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk";
import { updateCardStep, type UpdateCardInput } from "./steps/update-card";

// update-card — patch a gacha Card and re-sync its mirrored Product (fields,
// price, and PUBLISHED<->DRAFT for the for_sale toggle).
export const updateCardWorkflow = createWorkflow(
  "update-card",
  function (input: UpdateCardInput) {
    const result = updateCardStep(input);
    return new WorkflowResponse(result);
  }
);

export default updateCardWorkflow;

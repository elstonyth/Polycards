import {
  createWorkflow,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk";
import { deleteCardStep, type DeleteCardInput } from "./steps/delete-card";

// delete-card — remove a gacha Card, its PackOdds membership, and its mirrored
// Product (Pull history is kept).
export const deleteCardWorkflow = createWorkflow(
  "delete-card",
  function (input: DeleteCardInput) {
    const result = deleteCardStep(input);
    return new WorkflowResponse(result);
  }
);

export default deleteCardWorkflow;

import {
  createWorkflow,
  transform,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk";
import { deleteCardStep, type DeleteCardInput } from "./steps/delete-card";
import { recordAdminAuditStep } from "./steps/record-admin-audit";

// delete-card — unregister a gacha Card and its PackOdds membership. The
// inventory Product is KEPT (inventory-first model); Pull history is kept.
// The audit row (the card and every pack row it held) is written LAST: if it
// fails, the delete rolls back.
export const deleteCardWorkflow = createWorkflow(
  "delete-card",
  function (input: DeleteCardInput) {
    const result = deleteCardStep(input);
    recordAdminAuditStep(transform({ result }, (d) => d.result.audit));
    return new WorkflowResponse(
      transform({ result }, (d) => ({ handle: d.result.handle }))
    );
  }
);

export default deleteCardWorkflow;

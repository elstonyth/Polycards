import {
  createWorkflow,
  transform,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk";
import { deletePackStep, type DeletePackInput } from "./steps/delete-pack";
import { recordAdminAuditStep } from "./steps/record-admin-audit";

// delete-pack — remove a pack and its prize-pool membership (cards + Pull history
// kept). The audit row (the pack and its odds as they stood) is written LAST:
// if it fails, the delete rolls back.
export const deletePackWorkflow = createWorkflow(
  "delete-pack",
  function (input: DeletePackInput) {
    const result = deletePackStep(input);
    recordAdminAuditStep(transform({ result }, (d) => d.result.audit));
    return new WorkflowResponse(
      transform({ result }, (d) => ({ slug: d.result.slug }))
    );
  }
);

export default deletePackWorkflow;

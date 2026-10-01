import {
  createWorkflow,
  transform,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk";
import { updatePackStep, type UpdatePackInput } from "./steps/update-pack";
import { recordAdminAuditStep } from "./steps/record-admin-audit";

// update-pack — patch a pack's listing fields (slug is immutable). The audit
// row (settings before/after) is written LAST: if it fails, the edit rolls back.
export const updatePackWorkflow = createWorkflow(
  "update-pack",
  function (input: UpdatePackInput) {
    const result = updatePackStep(input);
    recordAdminAuditStep(transform({ result }, (d) => d.result.audit));
    return new WorkflowResponse(
      transform({ result }, (d) => ({ slug: d.result.slug }))
    );
  }
);

export default updatePackWorkflow;

import {
  createWorkflow,
  transform,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk";
import { createPackStep, type CreatePackInput } from "./steps/create-pack";
import { recordAdminAuditStep } from "./steps/record-admin-audit";

// create-pack — create a gacha Pack listing (empty prize pool until members are
// assigned). The audit row is written LAST: if it fails, the create rolls back.
export const createPackWorkflow = createWorkflow(
  "create-pack",
  function (input: CreatePackInput) {
    const result = createPackStep(input);
    recordAdminAuditStep(transform({ result }, (d) => d.result.audit));
    return new WorkflowResponse(
      transform({ result }, (d) => ({ slug: d.result.slug }))
    );
  }
);

export default createPackWorkflow;

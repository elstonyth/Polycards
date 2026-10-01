import {
  createWorkflow,
  transform,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk";
import {
  setPackMembersStep,
  type SetPackMembersInput,
} from "./steps/set-pack-members";
import { recordAdminAuditStep } from "./steps/record-admin-audit";

// set-pack-members — reconcile a pack's prize pool to a desired card set
// (add/remove PackOdds; shared rows keep their tuned weights). The audit row
// (pool before/after) is written LAST: if it fails, the edit rolls back.
export const setPackMembersWorkflow = createWorkflow(
  "set-pack-members",
  function (input: SetPackMembersInput) {
    const result = setPackMembersStep(input);
    recordAdminAuditStep(transform({ result }, (d) => d.result.audit));
    return new WorkflowResponse(
      transform({ result }, (d) => ({
        pack_id: d.result.pack_id,
        members: d.result.members,
        added: d.result.added,
        removed: d.result.removed,
      }))
    );
  }
);

export default setPackMembersWorkflow;

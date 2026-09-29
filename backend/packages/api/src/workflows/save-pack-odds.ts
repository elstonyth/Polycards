import {
  createWorkflow,
  transform,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk";
import { savePackOddsStep, type SavePackOddsInput } from "./steps/save-pack-odds";
import { recordAdminAuditStep } from "./steps/record-admin-audit";

// save-pack-odds — the admin win-rate editor's save process.
//
//   validate + even-split + persist odds and target RTP (compensated)
//   → record the before/after audit row
//
// The audit row is the LAST step: if it cannot be written, the engine restores
// the prior odds (and target RTP) through the save step's compensation, so no
// odds change ever lands without a record. The response is still the set-1
// computed odds the editor reads.
export const savePackOddsWorkflow = createWorkflow(
  "save-pack-odds",
  function (input: SavePackOddsInput) {
    const result = savePackOddsStep(input);
    recordAdminAuditStep(transform({ result }, (d) => d.result.audit));
    return new WorkflowResponse(
      transform({ result }, (d) => d.result.computed)
    );
  }
);

export default savePackOddsWorkflow;

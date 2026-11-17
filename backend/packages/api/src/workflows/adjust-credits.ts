import {
  createWorkflow,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk";
import {
  adjustCreditsStep,
  type AdjustCreditsInput,
} from "./steps/adjust-credits";

// adjust-credits — operator-applied signed ledger row (grant / refund /
// clawback) with a RM 0 balance floor. Single step, mirroring topup-credits;
// its compensator only runs for a later step or a cancel (README.md).
export const adjustCreditsWorkflow = createWorkflow(
  "adjust-credits",
  function (input: AdjustCreditsInput) {
    const result = adjustCreditsStep(input);
    return new WorkflowResponse(result);
  },
);

export default adjustCreditsWorkflow;

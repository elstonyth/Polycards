import {
  createWorkflow,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk";
import {
  topUpCreditsStep,
  type TopUpCreditsInput,
} from "./steps/topup-credits";

// topup-credits — buy site credit through the (mock) payment gateway: charge
// the gateway, append a positive ledger row. Single step; its compensator
// only runs once a later step (e.g. a real-gateway capture/audit) is added or a
// run is cancelled (README.md).
export const topUpCreditsWorkflow = createWorkflow(
  "topup-credits",
  function (input: TopUpCreditsInput) {
    const result = topUpCreditsStep(input);
    return new WorkflowResponse(result);
  }
);

export default topUpCreditsWorkflow;

import {
  createWorkflow,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk";
import { buybackPullStep, type BuybackPullInput } from "./steps/buyback-pull";

// buyback-pull — instant sell-back of a vaulted pull: credit the customer
// current-FMV × the pack's buyback %, flip the pull to bought_back, and return
// the physical unit to stock. Single step (its compensator only runs for a
// later step or a cancel, README.md); the pure composition body leaves room
// to append an audit/event step later.
export const buybackPullWorkflow = createWorkflow(
  "buyback-pull",
  function (input: BuybackPullInput) {
    const result = buybackPullStep(input);
    return new WorkflowResponse(result);
  }
);

export default buybackPullWorkflow;

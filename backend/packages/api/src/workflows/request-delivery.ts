import {
  createWorkflow,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk";
import {
  requestDeliveryStep,
  type RequestDeliveryInput,
} from "./steps/request-delivery";

// request-delivery — a customer requests physical delivery of a batch of
// vaulted pulls: validate ownership + vaulted state, snapshot the chosen
// address, create the order + items, and flip the pulls to delivering. Single
// step; its compensator only runs for a later step or a cancel (README.md),
// and the pure body leaves room to append an audit/event step.
export const requestDeliveryWorkflow = createWorkflow(
  "request-delivery",
  function (input: RequestDeliveryInput) {
    const result = requestDeliveryStep(input);
    return new WorkflowResponse(result);
  },
);

export default requestDeliveryWorkflow;

import {
  createWorkflow,
  WorkflowResponse,
} from '@medusajs/framework/workflows-sdk';
import {
  updateDeliveryOrderStep,
  type UpdateDeliveryOrderInput,
} from './steps/update-delivery-order';

// update-delivery-order — operator advances an order's status (with the
// transition rules in delivery.ts) and/or sets a tracking number. On delivered
// the covered pulls become delivered (terminal); on canceled they return to the
// vault. Single step; its compensator only runs for a later step or a cancel
// (README.md).
export const updateDeliveryOrderWorkflow = createWorkflow(
  'update-delivery-order',
  function (input: UpdateDeliveryOrderInput) {
    const result = updateDeliveryOrderStep(input);
    return new WorkflowResponse(result);
  },
);

export default updateDeliveryOrderWorkflow;

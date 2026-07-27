import {
  createWorkflow,
  WorkflowResponse,
} from '@medusajs/framework/workflows-sdk';
import {
  reorderPacksStep,
  type ReorderPacksInput,
} from './steps/reorder-packs';

// reorder-packs — batch rank update for the admin packs list.
export const reorderPacksWorkflow = createWorkflow(
  'reorder-packs',
  function (input: ReorderPacksInput) {
    const result = reorderPacksStep(input);
    return new WorkflowResponse(result);
  },
);

export default reorderPacksWorkflow;

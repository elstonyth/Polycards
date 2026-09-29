import {
  createWorkflow,
  transform,
  WorkflowResponse,
} from '@medusajs/framework/workflows-sdk';
import {
  reorderPacksStep,
  type ReorderPacksInput,
} from './steps/reorder-packs';
import { recordAdminAuditStep } from './steps/record-admin-audit';

// reorder-packs — batch rank update for the admin packs list. The audit row
// (ranks that moved) is written LAST: if it fails, the reorder rolls back.
export const reorderPacksWorkflow = createWorkflow(
  'reorder-packs',
  function (input: ReorderPacksInput) {
    const result = reorderPacksStep(input);
    recordAdminAuditStep(transform({ result }, (d) => d.result.audit));
    return new WorkflowResponse(
      transform({ result }, (d) => ({ updated: d.result.updated })),
    );
  },
);

export default reorderPacksWorkflow;

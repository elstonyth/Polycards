import {
  createWorkflow,
  transform,
  WorkflowResponse,
} from '@medusajs/framework/workflows-sdk';
import updateGoodsReceiveNoteRecordsStep, {
  type UpdateGoodsReceiveNoteRecordsInput,
} from './steps/update-goods-receive-note-records';
import adjustInventoryForPurchaseStep from './steps/adjust-inventory-for-purchase';

export type { UpdateGoodsReceiveNoteRecordsInput };

// update-goods-receive-note (owner 2026-11-03) — edits an open GRN, then
// moves the Medusa stock counter by the per-card difference only, with the
// same best-effort step a new GRN uses.
export const updateGoodsReceiveNoteWorkflow = createWorkflow(
  'update-goods-receive-note',
  (input: UpdateGoodsReceiveNoteRecordsInput) => {
    const grn = updateGoodsReceiveNoteRecordsStep(input);
    const counter = transform({ grn }, ({ grn }) => ({ lines: grn.delta }));
    adjustInventoryForPurchaseStep(counter);
    return new WorkflowResponse(grn);
  },
);

export default updateGoodsReceiveNoteWorkflow;

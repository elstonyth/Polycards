import {
  createWorkflow,
  WorkflowResponse,
} from '@medusajs/framework/workflows-sdk';
import createGoodsReceiveNoteRecordsStep, {
  type CreateGoodsReceiveNoteRecordsInput,
} from './steps/create-goods-receive-note-records';
import adjustInventoryForPurchaseStep from './steps/adjust-inventory-for-purchase';

export type { CreateGoodsReceiveNoteRecordsInput };

// create-goods-receive-note (spec 2026-10-28) — records the receipt, then
// raises the Medusa stock counter exactly as a purchase invoice does today
// (same best-effort step; a reversal's negative lines lower it again). The
// invoice later transferred from this GRN skips that step, so the counter
// moves once per physical card.
export const createGoodsReceiveNoteWorkflow = createWorkflow(
  'create-goods-receive-note',
  (input: CreateGoodsReceiveNoteRecordsInput) => {
    const grn = createGoodsReceiveNoteRecordsStep(input);
    adjustInventoryForPurchaseStep({ lines: input.lines });
    return new WorkflowResponse(grn);
  },
);

export default createGoodsReceiveNoteWorkflow;

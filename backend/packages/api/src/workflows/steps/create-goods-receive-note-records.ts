import { createStep, StepResponse } from '@medusajs/framework/workflows-sdk';
import { PACKS_MODULE } from '../../modules/packs';
import type PacksModuleService from '../../modules/packs/service';

export type GoodsReceiveNoteLineInput = {
  card_handle: string;
  card_name: string;
  fmv_snapshot: number; // MYR
  qty: number; // signed: negative only on a reversal
};

export type CreateGoodsReceiveNoteRecordsInput = {
  date: string;
  supplier: string;
  agent_user_id: string;
  reverses_grn_id: string | null;
  lines: GoodsReceiveNoteLineInput[];
};

type CompensateData = { grnId: string } | undefined;

// create-goods-receive-note-records — the GRN twin of
// create-purchase-invoice-records: header + lines + stock movements + audit in
// the packs module's own transaction. Compensation hard-deletes what this step
// created, and fires only if the later inventory-adjust step fails.
export const createGoodsReceiveNoteRecordsStep = createStep(
  'create-goods-receive-note-records',
  async (input: CreateGoodsReceiveNoteRecordsInput, { container }) => {
    const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
    const grn = await packs.createGoodsReceiveNoteWithLines(input);
    return new StepResponse(grn, { grnId: grn.id } satisfies CompensateData);
  },
  async (data: CompensateData, { container }) => {
    if (!data) return;
    const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
    await packs.deleteGoodsReceiveNoteCascade(data.grnId);
  },
);

export default createGoodsReceiveNoteRecordsStep;

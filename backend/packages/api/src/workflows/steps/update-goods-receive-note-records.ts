import { createStep, StepResponse } from '@medusajs/framework/workflows-sdk';
import { PACKS_MODULE } from '../../modules/packs';
import type PacksModuleService from '../../modules/packs/service';
import type { GoodsReceiveNoteLineInput } from './create-goods-receive-note-records';

export type UpdateGoodsReceiveNoteRecordsInput = {
  grn_id: string;
  date: string;
  supplier: string;
  agent_user_id: string;
  // The note's updated_at as the editor loaded it; a later save is refused.
  expected_updated_at?: string;
  lines: GoodsReceiveNoteLineInput[];
};

// update-goods-receive-note-records — header, lines, the stock movements for
// the difference and the audit row, in the packs module's own transaction.
// shortcut: no compensation, because the only later step
// (adjust-inventory-for-purchase) is best-effort per line and never throws;
// add one if a step that can fail is ever put after this.
export const updateGoodsReceiveNoteRecordsStep = createStep(
  'update-goods-receive-note-records',
  async (input: UpdateGoodsReceiveNoteRecordsInput, { container }) => {
    const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
    const { grn_id, ...edit } = input;
    return new StepResponse(
      await packs.updateGoodsReceiveNoteWithLines(grn_id, edit),
    );
  },
);

export default updateGoodsReceiveNoteRecordsStep;

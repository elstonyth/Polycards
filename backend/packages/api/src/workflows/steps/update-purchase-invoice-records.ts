import { createStep, StepResponse } from '@medusajs/framework/workflows-sdk';
import { PACKS_MODULE } from '../../modules/packs';
import type PacksModuleService from '../../modules/packs/service';

export type UpdatePurchaseInvoiceRecordsInput = {
  invoice_id: string;
  date: string;
  supplier: string;
  agent_user_id: string;
  // The invoice's updated_at as the editor loaded it; a later save is refused.
  expected_updated_at?: string;
  lines: {
    card_handle: string;
    card_name: string;
    fmv_snapshot: number;
    qty: number;
    unit_cost: number;
  }[];
};

// update-purchase-invoice-records — header, lines, the stock movements for
// the difference and the audit row, in the packs module's own transaction.
// shortcut: no compensation, because the only later step
// (adjust-inventory-for-purchase) is best-effort per line and never throws;
// add one if a step that can fail is ever put after this.
export const updatePurchaseInvoiceRecordsStep = createStep(
  'update-purchase-invoice-records',
  async (input: UpdatePurchaseInvoiceRecordsInput, { container }) => {
    const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
    const { invoice_id, ...edit } = input;
    return new StepResponse(
      await packs.updatePurchaseInvoiceWithLines(invoice_id, edit),
    );
  },
);

export default updatePurchaseInvoiceRecordsStep;

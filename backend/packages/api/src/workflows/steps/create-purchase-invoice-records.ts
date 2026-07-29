import { createStep, StepResponse } from '@medusajs/framework/workflows-sdk';
import { PACKS_MODULE } from '../../modules/packs';
import type PacksModuleService from '../../modules/packs/service';

export type InvoiceLineInput = {
  card_handle: string;
  card_name: string;
  fmv_snapshot: number; // MYR
  qty: number; // signed
  unit_cost: number; // MYR, positive
};

export type CreatePurchaseInvoiceRecordsInput = {
  date: string;
  supplier: string;
  agent_user_id: string;
  reverses_invoice_id: string | null;
  lines: InvoiceLineInput[];
};

type CompensateData = { invoiceId: string } | undefined;

// create-purchase-invoice-records — writes the invoice + lines + one
// 'purchase'-kind stock_movement row per line, all inside the packs module's
// own transaction. Compensation (invoked only if the LATER inventory-adjust
// step fails) hard-deletes everything this step created — invoices are
// immutable to callers, never to a same-operation rollback.
export const createPurchaseInvoiceRecordsStep = createStep(
  'create-purchase-invoice-records',
  async (input: CreatePurchaseInvoiceRecordsInput, { container }) => {
    const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
    const invoice = await packs.createPurchaseInvoiceWithLines(input);
    return new StepResponse(invoice, {
      invoiceId: invoice.id,
    } satisfies CompensateData);
  },
  async (data: CompensateData, { container }) => {
    if (!data) return;
    const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
    await packs.deletePurchaseInvoiceCascade(data.invoiceId);
  },
);

export default createPurchaseInvoiceRecordsStep;

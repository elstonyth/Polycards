import {
  createWorkflow,
  transform,
  WorkflowResponse,
} from '@medusajs/framework/workflows-sdk';
import updatePurchaseInvoiceRecordsStep, {
  type UpdatePurchaseInvoiceRecordsInput,
} from './steps/update-purchase-invoice-records';
import adjustInventoryForPurchaseStep from './steps/adjust-inventory-for-purchase';

export type { UpdatePurchaseInvoiceRecordsInput };

// update-purchase-invoice (user 2026-11-11) — edits an invoice, then moves
// the Medusa stock counter by the per-card difference only, with the same
// best-effort step a new invoice uses. A transferred invoice's difference is
// always empty: its goods receive note already moved the counter.
export const updatePurchaseInvoiceWorkflow = createWorkflow(
  'update-purchase-invoice',
  (input: UpdatePurchaseInvoiceRecordsInput) => {
    const invoice = updatePurchaseInvoiceRecordsStep(input);
    const counter = transform({ invoice }, ({ invoice }) => ({
      lines: invoice.delta,
    }));
    adjustInventoryForPurchaseStep(counter);
    return new WorkflowResponse(invoice);
  },
);

export default updatePurchaseInvoiceWorkflow;

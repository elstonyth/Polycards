import {
  createWorkflow,
  WorkflowResponse,
} from '@medusajs/framework/workflows-sdk';
import createPurchaseInvoiceRecordsStep, {
  type CreatePurchaseInvoiceRecordsInput,
} from './steps/create-purchase-invoice-records';
import adjustInventoryForPurchaseStep from './steps/adjust-inventory-for-purchase';

export type { CreatePurchaseInvoiceRecordsInput };

// create-purchase-invoice — records the receipt (records step), then raises
// physical stock for every tracked line (inventory step). Either both commit
// or neither does: an inventory-adjust failure rolls the records step back,
// so the invoice is never left disagreeing with the stock counter it exists
// to explain.
export const createPurchaseInvoiceWorkflow = createWorkflow(
  'create-purchase-invoice',
  (input: CreatePurchaseInvoiceRecordsInput) => {
    const invoice = createPurchaseInvoiceRecordsStep(input);
    adjustInventoryForPurchaseStep({ lines: input.lines });
    return new WorkflowResponse(invoice);
  },
);

export default createPurchaseInvoiceWorkflow;

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
// physical stock for every tracked line (inventory step).
//
// The records step is atomic (one transaction, including the reversal budget
// check). The inventory step is BEST-EFFORT by design (brief-specified): it
// try/catches per line, so an untracked handle — or a genuine adjust failure —
// warns and moves on rather than failing an invoice the operator has already
// physically received. Consequence to know about: the records step's
// compensation is therefore effectively unreachable from here, and a reversal
// of a tracked line with insufficient stock leaves a stock_movement of -10
// against a counter that did not move. That divergence is warn-only; on-hand
// is owned by card-stock.ts, and stock_movement is an audit log, never a
// source of truth (§3.1). Make the inventory step fail hard if the operator
// ever wants receipts to be all-or-nothing with the counter.
export const createPurchaseInvoiceWorkflow = createWorkflow(
  'create-purchase-invoice',
  (input: CreatePurchaseInvoiceRecordsInput) => {
    const invoice = createPurchaseInvoiceRecordsStep(input);
    adjustInventoryForPurchaseStep({ lines: input.lines });
    return new WorkflowResponse(invoice);
  },
);

export default createPurchaseInvoiceWorkflow;

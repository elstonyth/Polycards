// The JSON body of POST /admin/payments/deposits/:id/adjustment-entry, written
// once (ADR 0017). Types only, and no imports: the admin app type-checks this
// file, so pulling in the module would drag the whole backend into its build.
// A refusal is a MedusaError, not this shape.
export type LinkAdjustmentEntryResult = {
  linked: true;
  ref: string;
  /** The gateway's own id for the entry (GlobePay365: D…). */
  entryId: string | null;
};

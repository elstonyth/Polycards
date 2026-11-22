// The JSON body of POST /admin/payments/deposits/:id/credit-from-entry, written
// once (ADR 0017). Types only, and no imports: the admin app type-checks this
// file. A refusal is a MedusaError, not this shape.
export type CreditFromEntryResult = {
  credited: true;
  /** The ledger's answer: this credit was already on the anchor. */
  replayed: boolean;
  /** RM credited: the entry's amount through the row's FX lock. */
  amount: number;
  ref: string;
  /** The gateway's own id for the entry (GlobePay365: D…). */
  entryId: string | null;
};

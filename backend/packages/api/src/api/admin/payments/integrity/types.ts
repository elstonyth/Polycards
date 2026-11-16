// The JSON body of GET /admin/payments/integrity, written once (ADR 0017).
// Types only. Declared here rather than re-exported: money-integrity.ts
// reaches service.ts, and its `at` is a Date where the wire has a string.

/** Money a crash left half-moved. Detection only: nothing here moves money. */
export type MoneyIntegrityFinding = {
  kind: 'open_without_prize' | 'sold_without_flip' | 'denied_without_refund';
  /** The row to look at: the credit row, the pull, or the withdrawal. */
  id: string;
  customer_id: string;
  /** RM. */
  amount: number;
  at: string;
};

export type MoneyIntegrity = { findings: MoneyIntegrityFinding[] };

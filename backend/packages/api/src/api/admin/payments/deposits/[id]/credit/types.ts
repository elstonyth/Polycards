// The JSON body of POST /admin/payments/deposits/:id/credit, written once
// (ADR 0017). Types only. A refusal is a MedusaError, not this shape.
export type CreditDepositResult = { credited: true; replayed: boolean };

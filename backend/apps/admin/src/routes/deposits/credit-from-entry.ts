/**
 * Offer "Credit from gateway entry" on a USDT top-up the gateway kept failed:
 * the row closed (failed, or expired with no answer) and GlobePay365 booked
 * what arrived as its own manual entry. Pending rows may still be paid by the
 * sweep, settled ones are done. USDT only: GlobePay365 is the gateway that
 * books manual entries. The backend repeats every check; this only keeps the
 * button off rows it would refuse.
 */
export const canCreditFromEntry = (d: { status: string; currency: string }) =>
  (d.status === 'failed' || d.status === 'expired') && d.currency === 'USDT';

// Monotonic lifetime external spend, in SEN: Σ(−external_funded_cents) over
// ORIGINAL pack_open debits (amount<0). Reversals are amount>0 → excluded, so a
// refund never lowers the counter (spec §3). Mirrors the service raw SQL.
export function lifetimeExternalSen(
  rows: { amount: number; reason: string; external_funded_cents: number }[],
): number {
  let sen = 0;
  for (const r of rows) {
    if (r.reason === 'pack_open' && r.amount < 0)
      sen += -Math.round(r.external_funded_cents);
  }
  return sen;
}

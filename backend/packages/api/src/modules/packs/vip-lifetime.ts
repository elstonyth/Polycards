// Monotonic lifetime VIP turnover, in SEN: Σ(−amount×100) over ORIGINAL
// pack_open debits (amount<0), regardless of funding source — winnings-funded
// opens count (2026-07-22 turnover-VIP change). Referral commissions and the
// withdrawal playthrough gate still use the external-funded basis. Reversals
// are amount>0 → excluded, so a refund never lowers the counter (spec §3).
// Mirrors the service raw SQL (lifetimeExternalSenFor).
export function lifetimeExternalSen(
  rows: { amount: number; reason: string }[],
): number {
  let sen = 0;
  for (const r of rows) {
    if (r.reason === 'pack_open' && r.amount < 0)
      sen += Math.round(-r.amount * 100);
  }
  return sen;
}

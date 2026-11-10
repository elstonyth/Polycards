import type { GatewayReports } from './facets';
import { deniedWithoutRefund } from './gateway-withdrawal';

// Money writes that are two steps with no transaction across them: charge then
// card, sell-back credit then flip, Deny's close then refund. A process dying in
// between leaves one half. Nothing else revisits these, so this names them.
//
// Detection only. The money-integrity job refunds the first kind
// (refundUnfinishedOpen, under the per-open lock the card write takes, so the
// two never both land). The other two are rare enough for a person.

/** Long enough that a workflow still running has finished. */
const SETTLE_MS = 15 * 60 * 1000;
/** Shortcut: a finding nobody fixes leaves the list after this, and the query
 *  stays cheap. Widen it if one is ever missed. */
const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export type IntegrityFinding = {
  kind: 'open_without_prize' | 'sold_without_flip' | 'denied_without_refund';
  /** The row to look at: the credit row, the pull, or the withdrawal. */
  id: string;
  customer_id: string;
  /** RM. */
  amount: number;
  at: string | Date;
};

export async function moneyIntegrityFindings(
  packs: Pick<
    GatewayReports,
    | 'unfinishedMoneyRows'
    | 'listAdminActionAudits'
    | 'listGatewayWithdrawals'
    | 'listCreditTransactions'
  >,
  now = new Date(),
): Promise<IntegrityFinding[]> {
  const since = new Date(now.getTime() - WINDOW_MS);
  const until = new Date(now.getTime() - SETTLE_MS);

  const rows = await packs.unfinishedMoneyRows(since, until);

  const audits = await packs.listAdminActionAudits(
    {
      action: 'deny_withdrawal',
      created_at: { $gte: since, $lt: until },
    },
    { select: ['entity_id'], take: 500 },
  );
  const ids = [...new Set(audits.map((a) => a.entity_id))];
  const withdrawals = ids.length
    ? await packs.listGatewayWithdrawals(
        { id: ids, status: 'failed' },
        { take: ids.length },
      )
    : [];
  const stuck = await deniedWithoutRefund(packs, withdrawals);

  return [
    ...withdrawals
      .filter((w) => stuck.has(w.id))
      .map((w) => ({
        kind: 'denied_without_refund' as const,
        id: w.id,
        customer_id: w.customer_id,
        amount: Number(w.amount),
        at: w.created_at,
      })),
    ...rows.map((r) => ({ ...r, amount: Number(r.amount) })),
  ];
}

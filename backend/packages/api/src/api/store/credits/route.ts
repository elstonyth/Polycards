import {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import PacksModuleService from "../../../modules/packs/service";
import { PACKS_MODULE } from "../../../modules/packs";
import { parsePaginationParams } from "../../../utils/pagination";

// GET /store/credits — the authenticated customer's site-credit balance
// (paged Σ over the append-only ledger — exact at any size) plus a page of
// transactions (?limit=&offset=, newest first; take limit + 1 → has_more
// without a count query). The lifetime totals stay full-ledger, so they are
// accurate beyond the visible rows. Spending credit on packs lands with the
// payment phase; until then the balance only grows via buybacks.
const PAGE_SIZE = 20;

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const packs: PacksModuleService = req.scope.resolve(PACKS_MODULE);
  const customerId = req.auth_context.actor_id;
  const { limit, offset } = parsePaginationParams(req.query, {
    defaultLimit: PAGE_SIZE,
    maxLimit: 50,
  });

  // creditSummary already scans the full ledger; thread its scalars into
  // walletSummary so the wallet view reuses that one scan instead of issuing a
  // second identical SUM (balance/deposited/used are a strict subset). This
  // serializes walletSummary after creditSummary — intended; it still runs its
  // own isFrozen query.
  const [summary, txnRows] = await Promise.all([
    packs.creditSummary(customerId),
    packs.listCreditTransactions(
      { customer_id: customerId },
      // id tiebreaker: batch buybacks land sibling rows in the same instant,
      // and created_at alone gives no stable order across offset pages.
      { order: { created_at: "DESC", id: "DESC" }, take: limit + 1, skip: offset }
    ),
  ]);
  const hasMore = txnRows.length > limit;
  const transactions = txnRows.slice(0, limit);
  const wallet = await packs.walletSummary(customerId, {
    balance: summary.balance,
    depositedCents: Math.round(summary.depositedPlaythroughTotal * 100),
    usedCents: Math.round(summary.externalFundedSpendTotal * 100),
  });

  // Gateway facts for the money rows on this page: which channel, and what
  // the gateway's own outcome was. The ledger row is written only from a
  // gateway-confirmed settlement, so this is the customer-facing trace back
  // to the gateway record (the reference is the gateway's id, or our merchant
  // reference when the gateway never issued one).
  const isMoneyRow = (reason: string) =>
    reason === "topup" || reason === "cashout";
  const refs = transactions
    .filter((t) => isMoneyRow(t.reason) && t.reference)
    .map((t) => t.reference as string);
  const gatewayByRef = new Map<string, { method: string; status: string }>();
  if (refs.length > 0) {
    const byRef = {
      $or: [{ gateway_transaction_id: refs }, { merchant_transaction_id: refs }],
    };
    const [deposits, withdrawals] = await Promise.all([
      packs.listGlobePayDeposits(byRef, { take: refs.length * 2 }),
      packs.listGlobePayWithdrawals(byRef, { take: refs.length * 2 }),
    ]);
    for (const d of deposits) {
      const fact = { method: d.payment_method_code, status: d.status };
      if (d.gateway_transaction_id) gatewayByRef.set(d.gateway_transaction_id, fact);
      gatewayByRef.set(d.merchant_transaction_id, fact);
    }
    for (const w of withdrawals) {
      const fact = { method: "WD", status: w.status };
      if (w.gateway_transaction_id) gatewayByRef.set(w.gateway_transaction_id, fact);
      gatewayByRef.set(w.merchant_transaction_id, fact);
    }
  }

  res.json({
    balance: summary.balance,
    topup_total: summary.topupTotal,
    spend_total: summary.spendTotal,
    transactions: transactions.map((t) => {
      // Payment-gateway reference — the id support and the customer quote to
      // the gateway; same value the admin pages and receipt emails show.
      // WHITELISTED by reason, not passed through: adjustment rows carry the
      // admin's free-text note (also the audit reason) in this column, and
      // reversal rows carry internal txn ids — neither may reach a customer.
      const reference = isMoneyRow(t.reason) ? t.reference || null : null;
      return {
        id: t.id,
        amount: Number(t.amount),
        reason: t.reason,
        reference,
        gateway: reference ? (gatewayByRef.get(reference) ?? null) : null,
        pull_id: t.pull_id,
        created_at: t.created_at,
      };
    }),
    has_more: hasMore,
    wallet: {
      balance: wallet.balance,
      available: wallet.available,
      is_frozen: wallet.isFrozen,
      // Playthrough gate (withdrawable.ts): deposits must be fully spent on
      // pack opens before balance can be withdrawn. withdrawable = 0 while
      // playthrough.remaining > 0; spending on packs is never restricted.
      withdrawable: wallet.withdrawable,
      playthrough: {
        deposited: wallet.playthrough.deposited,
        used: wallet.playthrough.used,
        remaining: wallet.playthrough.remaining,
      },
    },
  });
}

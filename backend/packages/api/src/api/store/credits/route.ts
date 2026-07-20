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
  // own lockedCommission/nextUnlock/isFrozen queries.
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

  res.json({
    balance: summary.balance,
    topup_total: summary.topupTotal,
    spend_total: summary.spendTotal,
    transactions: transactions.map((t) => ({
      id: t.id,
      amount: Number(t.amount),
      reason: t.reason,
      pull_id: t.pull_id,
      created_at: t.created_at,
    })),
    has_more: hasMore,
    wallet: {
      balance: wallet.balance,
      available: wallet.available,
      locked: wallet.locked,
      is_frozen: wallet.isFrozen,
      next_unlock: wallet.nextUnlock
        ? { amount: wallet.nextUnlock.amount, date: wallet.nextUnlock.date }
        : null,
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

import {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import {
  resolvePacks,
  type CustomerWallet,
} from '../../../modules/packs/facets';
import { forPacksCents } from '../../../modules/packs/credit-summary';
import { pullPackTitle } from '../../../modules/packs/pull-history';
import { parsePaginationParams } from '../../../utils/pagination';
import { pageAll } from '../../utils/page-all';

// GET /store/credits — the authenticated customer's site-credit balance
// (paged Σ over the append-only ledger — exact at any size) plus a page of
// transactions (?limit=&offset=, newest first; take limit + 1 → has_more
// without a count query). The lifetime totals stay full-ledger, so they are
// accurate beyond the visible rows. Spending credit on packs lands with the
// payment phase; until then the balance only grows via buybacks.
const PAGE_SIZE = 20;

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const packs = resolvePacks<CustomerWallet>(req.scope);
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
      {
        order: { created_at: 'DESC', id: 'DESC' },
        take: limit + 1,
        skip: offset,
      },
    ),
  ]);
  const hasMore = txnRows.length > limit;
  const transactions = txnRows.slice(0, limit);
  const wallet = await packs.walletSummary(customerId, {
    balance: summary.balance,
    depositedCents: Math.round(summary.depositedPlaythroughTotal * 100),
    usedCents: Math.round(summary.externalFundedSpendTotal * 100),
    bonusCents: Math.round(summary.bonusBalance * 100),
    hasTopup: summary.topupTotal > 0,
  });

  // Gateway facts for the money rows on this page: which channel, and what
  // the gateway's own outcome was. The ledger row is written only from a
  // gateway-confirmed settlement, so this is the customer-facing trace back
  // to the gateway record (the reference is the gateway's id, or our merchant
  // reference when the gateway never issued one).
  const isMoneyRow = (reason: string) =>
    reason === 'topup' || reason === 'cashout';
  const refs = transactions
    .filter((t) => isMoneyRow(t.reason) && t.reference)
    .map((t) => t.reference as string);
  const gatewayByRef = new Map<string, { method: string; status: string }>();
  if (refs.length > 0) {
    const byRef = {
      $or: [
        { gateway_transaction_id: refs },
        { merchant_transaction_id: refs },
      ],
    };
    const [deposits, withdrawals] = await Promise.all([
      packs.listGatewayDeposits(byRef, { take: refs.length * 2 }),
      packs.listGatewayWithdrawals(byRef, { take: refs.length * 2 }),
    ]);
    for (const d of deposits) {
      const fact = { method: d.payment_method_code, status: d.status };
      if (d.gateway_transaction_id)
        gatewayByRef.set(d.gateway_transaction_id, fact);
      gatewayByRef.set(d.merchant_transaction_id, fact);
    }
    for (const w of withdrawals) {
      const fact = { method: 'WD', status: w.status };
      if (w.gateway_transaction_id)
        gatewayByRef.set(w.gateway_transaction_id, fact);
      gatewayByRef.set(w.merchant_transaction_id, fact);
    }
  }

  // The card(s) behind each pack open and sell-back on this page, so the row
  // says what it was instead of a bare "Pack open −RM 45". A sell-back names
  // its pull; a pack open names the pulls of its open (pull.open_id is the
  // charge's source_transaction_id; a batch open is one row for 1–3 cards).
  const soldPullIds = transactions
    .filter((t) => t.reason === 'buyback' && t.pull_id)
    .map((t) => t.pull_id as string);
  const openIds = transactions
    .filter((t) => t.reason === 'pack_open' && t.source_transaction_id)
    .map((t) => t.source_transaction_id as string);
  const pullLinks = [
    ...(soldPullIds.length ? [{ id: soldPullIds }] : []),
    ...(openIds.length ? [{ open_id: openIds }] : []),
  ];
  const linkedPulls = pullLinks.length
    ? await pageAll((opts) =>
        packs.listPulls({ customer_id: customerId, $or: pullLinks }, opts),
      )
    : [];
  // A ticket pack's open has spins, not pulls: they name its pack instead.
  const linkedSpins = openIds.length
    ? await pageAll((opts) =>
        packs.listTicketSpins(
          { customer_id: customerId, open_id: openIds },
          { ...opts, select: ['open_id', 'pack_id'] },
        ),
      )
    : [];
  const spinPackByOpen = new Map(
    linkedSpins.map((s) => [s.open_id, s.pack_id]),
  );
  const linkedHandles = [...new Set(linkedPulls.map((p) => p.card_id))];
  const linkedSlugs = [
    ...new Set([
      ...linkedPulls.map((p) => p.pack_id),
      ...linkedSpins.map((s) => s.pack_id),
    ]),
  ];
  const [linkedCards, linkedPacks] = await Promise.all([
    linkedHandles.length
      ? packs.listCards(
          { handle: linkedHandles },
          { take: linkedHandles.length },
        )
      : Promise.resolve([]),
    linkedSlugs.length
      ? packs.listPacks({ slug: linkedSlugs }, { take: linkedSlugs.length })
      : Promise.resolve([]),
  ]);
  const cardName = new Map(linkedCards.map((c) => [c.handle, c.name]));
  const packTitle = new Map(linkedPacks.map((p) => [p.slug, p.title]));
  const pullsFor = (t: (typeof transactions)[number]) =>
    t.reason === 'buyback' && t.pull_id
      ? linkedPulls.filter((p) => p.id === t.pull_id)
      : t.reason === 'pack_open' && t.source_transaction_id
        ? linkedPulls.filter((p) => p.open_id === t.source_transaction_id)
        : [];

  res.json({
    balance: summary.balance,
    topup_total: summary.topupTotal,
    // Every debit, kept for older storefronts. The history shows the two
    // below instead (2026-10-15): a withdrawal is not spending.
    spend_total: summary.spendTotal,
    // Everything spent on pack opens, bonus part included, net of reversals;
    // and cashouts net of refunds. Delivery fees are in neither.
    pack_spend_total: summary.packSpendTotal,
    withdrawn_total: summary.withdrawnTotal,
    transactions: transactions.map((t) => {
      // Payment-gateway reference — the id support and the customer quote to
      // the gateway; same value the admin pages and receipt emails show.
      // WHITELISTED by reason, not passed through: adjustment rows carry the
      // admin's free-text note (also the audit reason) in this column, and
      // reversal rows carry internal txn ids — neither may reach a customer.
      const reference = isMoneyRow(t.reason) ? t.reference || null : null;
      const rowPulls = pullsFor(t);
      const spinPack =
        t.reason === 'pack_open' && t.source_transaction_id
          ? spinPackByOpen.get(t.source_transaction_id)
          : undefined;
      return {
        // What the row bought or sold: its pack and card names (empty / null
        // on rows with no pull, or pulls whose card was since deleted).
        pack_title: rowPulls[0]
          ? pullPackTitle(rowPulls[0], packTitle.get(rowPulls[0].pack_id))
          : spinPack
            ? (packTitle.get(spinPack) ?? spinPack)
            : null,
        card_names: rowPulls
          .map((p) => cardName.get(p.card_id))
          .filter((n): n is string => !!n),
        id: t.id,
        amount: Number(t.amount),
        reason: t.reason,
        reference,
        gateway: reference ? (gatewayByRef.get(reference) ?? null) : null,
        pull_id: t.pull_id,
        // The row's spend-only bonus part (MYR, spec 2026-10-07): a grant or
        // a bonus-funded open (a sell-back's free share is stamped as
        // external_funded_cents instead — see playthrough below).
        bonus: Number(t.bonus_cents ?? 0) / 100,
        // Signed move into (+) or out of (−) "still to use on packs" (MYR,
        // spec 2026-10-15 §5): + a top-up with a basis, + a sell-back's
        // stamped free share (the bonus-paid share or a welcome card; gift
        // and reward sales are stamped only before 2026-10-15, ADR 0012),
        // − the for-packs money a pack open used (its reversal gives it
        // back); 0 on every other row. Was buyback-only and ≥ 0 until 2026-10-15; extended
        // in place rather than adding a parallel field. The marks add up to
        // playthrough.deposited − used.
        playthrough:
          forPacksCents({
            amount: Number(t.amount),
            reason: t.reason,
            externalFundedCents:
              t.external_funded_cents == null
                ? null
                : Number(t.external_funded_cents),
          }) / 100,
        created_at: t.created_at,
      };
    }),
    has_more: hasMore,
    wallet: {
      balance: wallet.balance,
      available: wallet.available,
      is_frozen: wallet.isFrozen,
      // No top-up ever = withdrawals and deliveries locked (2026-10-11).
      has_topup: wallet.hasTopup,
      // Playthrough gate (withdrawable.ts, ADR 0013): withdrawable is 0 while
      // playthrough.remaining > 0, else available − bonus (≥ 0). Spending on
      // packs is never restricted.
      withdrawable: wallet.withdrawable,
      // Spend-only bonus credit inside balance (spec 2026-10-07) — never
      // withdrawable; the wallet page shows it apart.
      bonus: wallet.bonus,
      playthrough: {
        deposited: wallet.playthrough.deposited,
        used: wallet.playthrough.used,
        remaining: wallet.playthrough.remaining,
      },
    },
  });
}

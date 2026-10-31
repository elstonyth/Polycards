import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { PACKS_MODULE } from '../../../../../modules/packs';
import type PacksModuleService from '../../../../../modules/packs/service';
import { parsePaginationParams } from '../../../../../utils/pagination';
import { parseReasons } from './reasons';

// GET /admin/customers/:id/transactions — paginated credit ledger for the
// support view. Same row shape as the gacha route's `transactions` slice,
// plus each row's bonus part. Optional ?reasons=topup,cashout keeps only those
// reasons (the player page's Wallet filter); an unknown one is a 400.
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const { id } = req.params;
  const reasons = parseReasons(req.query.reasons);
  if (reasons === 'invalid') {
    res.status(400).json({
      message: 'reasons must be a comma list of credit transaction reasons.',
    });
    return;
  }
  const { limit, offset } = parsePaginationParams(
    { limit: req.query.limit, offset: req.query.offset },
    { defaultLimit: 25, maxLimit: 100 },
  );
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  // `id` tiebreaker: offset pagination needs a unique secondary sort key or
  // rows sharing a `created_at` can appear on two pages or on neither.
  const [rows, total] = await packs.listAndCountCreditTransactions(
    reasons ? { customer_id: id, reason: reasons } : { customer_id: id },
    { order: { created_at: 'DESC', id: 'DESC' }, skip: offset, take: limit },
  );
  // Ledger display id where present (POLYCARD-BACK §4.3 Wallet tab). SP rows
  // key on source_transaction_id (the open_id); TP/SE/AD key on the
  // credit_transaction's own id (see each writer's ref_id choice in the
  // ledger epic plan). ONE batched lookup, not per-row.
  const refIds = rows
    .map((t: any) =>
      t.reason === 'pack_open' ? t.source_transaction_id : t.id,
    )
    .filter((r: unknown): r is string => typeof r === 'string' && r !== '');
  const ledgerRows = refIds.length
    ? await packs.listLedgerEntries(
        { ref_id: refIds },
        // Deliberately uncapped: buildQuery leaves limit undefined without
        // `take`, and a cap here would silently drop display ids (no error) if
        // two ledger types ever shared a ref_id.
        { select: ['ref_id', 'display_id'] },
      )
    : [];
  // Typed inline rather than `any`: the `select` above pins exactly these two
  // columns, and the generated listLedgerEntries return type is too loose to
  // say so. (The `t: any`s on credit_transaction rows are this file's
  // pre-existing style, untouched here.)
  const displayIdByRefId = new Map<string, string>(
    ledgerRows.map((l: { ref_id: string; display_id: string }) => [
      l.ref_id,
      l.display_id,
    ]),
  );
  // What each row was about: the pack and cards behind a pack_open (open_id)
  // or a buyback (pull_id). One batched read each per page, never per row.
  const openIds = rows
    .filter((t: any) => t.reason === 'pack_open' && t.source_transaction_id)
    .map((t: any) => t.source_transaction_id as string);
  const soldPullIds = rows
    .filter((t: any) => t.reason === 'buyback' && t.pull_id)
    .map((t: any) => t.pull_id as string);
  const [openPulls, soldPulls, spins] = await Promise.all([
    openIds.length
      ? packs.listPulls({ customer_id: id, open_id: openIds })
      : [],
    soldPullIds.length
      ? packs.listPulls({ customer_id: id, id: soldPullIds })
      : [],
    // A ticket pack's open writes spins, not pulls: no card, but still a pack.
    openIds.length
      ? packs.listTicketSpins({ customer_id: id, open_id: openIds })
      : [],
  ]);
  const seenPulls = [...openPulls, ...soldPulls];
  const handles = [...new Set(seenPulls.map((p: any) => p.card_id as string))];
  const slugs = [
    ...new Set(
      [...seenPulls, ...spins].map((p: any) => p.pack_id as string),
    ),
  ];
  const [cards, packRows, balanceAfter] = await Promise.all([
    handles.length
      ? packs.listCards({ handle: handles }, { take: handles.length })
      : [],
    slugs.length
      ? packs.listPacks({ slug: slugs }, { take: slugs.length })
      : [],
    packs.balanceAfterRows(
      id,
      rows.map((t: any) => t.id as string),
    ),
  ]);
  const cardByHandle = new Map(
    cards.map((c: any): [string, any] => [c.handle, c]),
  );
  const packTitleBySlug = new Map(
    packRows.map((p: any): [string, string] => [p.slug, p.title]),
  );
  const subject = (p: any) => ({
    pull_id: p.id as string,
    name: (cardByHandle.get(p.card_id)?.name ?? p.card_id) as string,
    image: (cardByHandle.get(p.card_id)?.image ?? null) as string | null,
  });
  const pullsForRow = (t: any): any[] =>
    t.reason === 'pack_open'
      ? openPulls.filter((p: any) => p.open_id === t.source_transaction_id)
      : t.reason === 'buyback'
        ? soldPulls.filter((p: any) => p.id === t.pull_id)
        : [];
  res.json({
    total,
    items: rows.map((t: any) => {
      const pulls = pullsForRow(t);
      return {
        id: t.id,
        amount: Number(t.amount),
        // The spend-only bonus part of the row (signed like it), RM.
        bonus: Number(t.bonus_cents ?? 0) / 100,
        reason: t.reason,
        reference: t.reference ?? null,
        created_at: t.created_at,
        ledger_display_id:
          displayIdByRefId.get(
            t.reason === 'pack_open' ? t.source_transaction_id : t.id,
          ) ?? null,
        balance_after: balanceAfter.get(t.id) ?? null,
        // A reward's slug (task-reward) has no pack row and no title to show.
        pack_title:
          packTitleBySlug.get(
            pulls[0]?.pack_id ??
              (t.reason === 'pack_open'
                ? spins.find(
                    (s: any) => s.open_id === t.source_transaction_id,
                  )?.pack_id
                : undefined),
          ) ?? null,
        cards: pulls.map(subject),
        // A shipping fee's reference is its order id (a refund's is
        // `refund:<order id>`).
        order_id:
          t.reason === 'delivery_fee' && t.reference
            ? String(t.reference).replace(/^refund:/, '')
            : null,
      };
    }),
  });
}

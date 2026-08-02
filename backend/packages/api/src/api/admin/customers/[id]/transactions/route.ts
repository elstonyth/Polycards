import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { PACKS_MODULE } from '../../../../../modules/packs';
import type PacksModuleService from '../../../../../modules/packs/service';
import { parsePaginationParams } from '../../../../../utils/pagination';

// GET /admin/customers/:id/transactions — paginated credit ledger for the
// support view. Same row shape as the gacha route's `transactions` slice.
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const { id } = req.params;
  const { limit, offset } = parsePaginationParams(
    { limit: req.query.limit, offset: req.query.offset },
    { defaultLimit: 25, maxLimit: 100 },
  );
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  // `id` tiebreaker: offset pagination needs a unique secondary sort key or
  // rows sharing a `created_at` can appear on two pages or on neither.
  const [rows, total] = await packs.listAndCountCreditTransactions(
    { customer_id: id },
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
  res.json({
    total,
    items: rows.map((t: any) => ({
      id: t.id,
      amount: Number(t.amount),
      reason: t.reason,
      reference: t.reference ?? null,
      created_at: t.created_at,
      ledger_display_id:
        displayIdByRefId.get(
          t.reason === 'pack_open' ? t.source_transaction_id : t.id,
        ) ?? null,
    })),
  });
}

import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { Modules } from '@medusajs/framework/utils';
import type { ICustomerModuleService } from '@medusajs/framework/types';
import { PACKS_MODULE } from '../../../modules/packs';
import type PacksModuleService from '../../../modules/packs/service';
import { parsePaginationParams } from '../../../utils/pagination';
import {
  parseMytBound,
  type LedgerPayload,
  type LedgerType,
} from '../../../modules/packs/ledger';

const LEDGER_TYPES: LedgerType[] = ['TP', 'SP', 'SE', 'OD', 'RF', 'AD', 'WP'];

export type AdminLedgerRow = {
  id: string;
  display_id: string;
  type: LedgerType;
  customer: { id: string; email: string; name: string | null };
  occurred_at: string;
  wallet_delta: number | null;
  vault_delta: number | null;
  payload: LedgerPayload;
};

// Narrow the untyped jsonb column at THIS one read boundary — the same
// "as unknown as X" idiom service.ts already uses for rank_rewards, kept to
// one place so casts don't spread into callers.
const asPayload = (v: unknown): LedgerPayload => v as unknown as LedgerPayload;

// GET /admin/ledger — the Transactions list (POLYCARD-BACK §5.4).
//
// RF and WP are offered as filters but no writer produces them yet (no
// referral-payout or challenge-settlement job exists, and Epic 6 is
// cancelled), so those two return zero rows. The whole table is go-forward
// only (D4, no backfill) — an empty list before this epic deployed is correct,
// not a bug.
//
// ?from/?to are MYT CALENDAR DAYS, half-open [from, to+1day) — see
// parseMytBound. Task 10 shipped the date pickers this was waiting on, so the
// day is now resolved in the operator's own zone rather than UTC.
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const { limit, offset } = parsePaginationParams(
    { limit: req.query.limit, offset: req.query.offset },
    { defaultLimit: 50, maxLimit: 200 },
  );
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const customers = req.scope.resolve<ICustomerModuleService>(Modules.CUSTOMER);

  const rawType = req.query.type;
  const type =
    typeof rawType === 'string' && (LEDGER_TYPES as string[]).includes(rawType)
      ? (rawType as LedgerType)
      : undefined;
  const rawQ = req.query.q;
  const q =
    typeof rawQ === 'string' && rawQ.trim() !== ''
      ? rawQ.trim().slice(0, 100)
      : undefined;
  const from = parseMytBound(req.query.from, 'from');
  const to = parseMytBound(req.query.to, 'to');

  // `q` also matches the player — resolved here because the customer table
  // lives in another module, so the ledger query can't join it.
  let matchingCustomerIds: string[] | undefined;
  if (q) {
    const [matches] = await customers.listAndCountCustomers(
      { q },
      { take: 200, select: ['id'] },
    );
    matchingCustomerIds = matches.map((c) => c.id);
  }

  const { entries, total } = await packs.listLedgerEntriesForAdmin({
    type,
    q,
    matchingCustomerIds,
    from,
    to,
    limit,
    offset,
  });

  // ONE batched customer lookup for the whole page, never per row.
  const customerIds = [...new Set(entries.map((e) => e.customer_id))];
  const rows = customerIds.length
    ? await customers.listCustomers(
        { id: customerIds },
        { take: customerIds.length, select: ['id', 'email', 'first_name', 'last_name'] },
      )
    : [];
  const byId = new Map(rows.map((c) => [c.id, c]));

  res.json({
    total,
    offset,
    limit,
    entries: entries.map((e): AdminLedgerRow => {
      const c = byId.get(e.customer_id);
      const name = c
        ? [c.first_name, c.last_name].filter(Boolean).join(' ') || null
        : null;
      return {
        id: e.id,
        display_id: e.display_id,
        type: e.type,
        customer: { id: e.customer_id, email: c?.email ?? '', name },
        occurred_at: e.occurred_at,
        wallet_delta: e.wallet_delta === null ? null : Number(e.wallet_delta),
        vault_delta: e.vault_delta === null ? null : Number(e.vault_delta),
        payload: asPayload(e.payload),
      };
    }),
  });
}

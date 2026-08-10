import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { MedusaError, Modules } from '@medusajs/framework/utils';
import type { ICustomerModuleService } from '@medusajs/framework/types';
import { PACKS_MODULE } from '../../../modules/packs';
import type PacksModuleService from '../../../modules/packs/service';
import {
  parsePaginationParams,
  parseSortParam,
} from '../../../utils/pagination';
import {
  parseMytBound,
  type LedgerPayload,
  type LedgerType,
} from '../../../modules/packs/ledger';

const LEDGER_TYPES: LedgerType[] = [
  'TP',
  'SP',
  'SE',
  'OD',
  'RF',
  'AD',
  'WP',
  'WD',
];

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

const bad = (message: string): never => {
  throw new MedusaError(MedusaError.Types.INVALID_DATA, message);
};

// ?type= — reject anything not in the enum. Silently ignoring it returned
// EVERY type, i.e. a mistyped filter showed the operator MORE money rows than
// they asked for. '' is "absent" (a cleared control), matching
// delivery-orders/validate.ts coerceStatusFilter.
function coerceTypeFilter(raw: unknown): LedgerType | undefined {
  if (raw === undefined || raw === '') return undefined;
  if (typeof raw !== 'string' || !(LEDGER_TYPES as string[]).includes(raw)) {
    bad(`Invalid type filter '${String(raw)}'.`);
  }
  return raw as LedgerType;
}

// ?from=/?to= — same rule for the date bounds: an unparseable one used to be
// dropped, widening the window to ALL dates. parseMytBound stays pure (no
// Medusa imports) and keeps signalling "not a date" with undefined; the 400
// lives here, where the request boundary is.
function coerceMytBound(raw: unknown, edge: 'from' | 'to'): Date | undefined {
  if (raw === undefined || raw === '') return undefined;
  const d = parseMytBound(raw, edge);
  if (!d)
    bad(`Invalid \`${edge}\` date '${String(raw)}' (expected YYYY-MM-DD).`);
  return d;
}

// ?q= — same rule again. `?q=a&q=b` arrives as an ARRAY, which the old
// inline `typeof rawQ === 'string'` check dropped silently, widening the
// result set to every row for the same reason ?type and ?from now reject.
// A whitespace-only q stays "no filter" (a cleared control), not a 400.
function coerceQ(raw: unknown): string | undefined {
  if (raw === undefined || raw === '') return undefined;
  if (typeof raw !== 'string') bad(`Invalid \`q\` filter '${String(raw)}'.`);
  const trimmed = (raw as string).trim();
  if (trimmed === '') return undefined;
  // Truncated FIRST, escaped SECOND (per purchase-invoices/route.ts:128-136):
  // escaping before the cut could sever an escape pair. Unescaped, `?q=%`
  // widens the ILIKE below to `%%%` and returns the WHOLE table while the
  // operator believes they filtered — not an injection fix (the value is
  // bound), just an honesty fix for what the filter actually matches.
  return trimmed.slice(0, 100).replace(/[\\%_]/g, (c) => `\\${c}`);
}

// GET /admin/ledger — the Transactions list (POLYCARD-BACK §5.4).
//
// WP is written by settleChallengeWinner (Plan 060) when a weekly-challenge
// winner is settled. RF is still writerless — Epic 6 (referral payouts) is
// cancelled, so that filter returns zero rows. The whole table is go-forward
// only (D4, no backfill) — an empty list for rows predating a type's writer
// is correct, not a bug.
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

  const type = coerceTypeFilter(req.query.type);
  const q = coerceQ(req.query.q);
  const from = coerceMytBound(req.query.from, 'from');
  const to = coerceMytBound(req.query.to, 'to');

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

  // Sortable columns are an allowlist (silent degrade, purchase-invoices
  // precedent) — deliberately narrower than the SELECT list: customer name/
  // email live in another module and the wallet/vault deltas render as one
  // combined Affect cell, so neither is offered. The service re-maps the key
  // through its own literal table before it reaches the raw ORDER BY.
  const { key, dir } = parseSortParam(
    req.query.sort,
    new Set(['occurred_at', 'display_id', 'type']),
    'occurred_at',
  );

  const { entries, total } = await packs.listLedgerEntriesForAdmin({
    type,
    q,
    matchingCustomerIds,
    from,
    to,
    limit,
    offset,
    sort: { key: key as 'occurred_at' | 'display_id' | 'type', dir },
  });

  // ONE batched customer lookup for the whole page, never per row.
  const customerIds = [...new Set(entries.map((e) => e.customer_id))];
  const rows = customerIds.length
    ? await customers.listCustomers(
        { id: customerIds },
        {
          take: customerIds.length,
          select: ['id', 'email', 'first_name', 'last_name'],
        },
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

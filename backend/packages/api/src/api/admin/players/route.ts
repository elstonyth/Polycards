import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { MedusaError, Modules } from '@medusajs/framework/utils';
import type { ICustomerModuleService } from '@medusajs/framework/types';
import { PACKS_MODULE } from '../../../modules/packs';
import type PacksModuleService from '../../../modules/packs/service';
import { resolveFxRate } from '../../../modules/packs/pricing';
import {
  parsePaginationParams,
  parseSortParam,
} from '../../../utils/pagination';

// Sortable columns are an allowlist, not a passthrough — `order` goes straight
// into the customer query builder. Only real `customer` columns qualify:
// everything else on a player row (wallet, vault, spend, pulls, VIP level) is a
// JS-side aggregate over the ALREADY-PAGED ids, so ordering on it server-side
// would need a different query shape entirely, not an option change. `name` is
// the JS join of first_name + last_name, expressed as the two columns in order.
const SORTABLE = new Set(['created_at', 'email', 'name']);

// GET /admin/players — the All Players list (POLYCARD-BACK §4.2). Page of
// Medusa customers + batched per-player aggregates (playersOverview): one
// query per aggregate per page, never per-row. The native /admin/customers
// route is untouched; this is the UI-facing list.
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const { limit, offset } = parsePaginationParams(
    { limit: req.query.limit, offset: req.query.offset },
    { defaultLimit: 50, maxLimit: 200 },
  );
  const rawQ = req.query.q;
  // `?q=a&q=b` arrives as an ARRAY. The old inline `typeof rawQ === 'string'`
  // check below silently dropped it (treated as absent), widening the result
  // set to every player — same rule as ledger/route.ts's coerceQ. (Only the
  // array handling is fixed here — this `q` feeds Medusa's own customer
  // search, not this repo's ILIKE builder, so no escaping is added.)
  if (rawQ !== undefined && typeof rawQ !== 'string') {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `Invalid \`q\` filter '${String(rawQ)}'.`,
    );
  }
  const q =
    typeof rawQ === 'string' && rawQ.trim() !== ''
      ? rawQ.trim().slice(0, 100)
      : undefined;

  const customers = req.scope.resolve<ICustomerModuleService>(Modules.CUSTOMER);
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);

  const { key: sortKey, dir: sortDir } = parseSortParam(
    req.query.sort,
    SORTABLE,
    'created_at',
  );
  // `id` is the tiebreaker, not decoration: email/name are non-unique enough to
  // reorder rows across pages without it (purchase-invoices precedent).
  const order =
    sortKey === 'name'
      ? { first_name: sortDir, last_name: sortDir, id: sortDir }
      : { [sortKey]: sortDir, id: sortDir };

  // ponytail: to-many `groups` join under skip/take — Medusa paginates on the
  // customer, and players-list.spec.ts pages limit=1 with a grouped customer in
  // the set, so this holds; revisit only if a page ever short-counts.
  const [page, total] = await customers.listAndCountCustomers(q ? { q } : {}, {
    skip: offset,
    take: limit,
    order,
    relations: ['groups'],
  });
  const ids = page.map((c) => c.id);
  const fx = await resolveFxRate(packs);
  const agg = await packs.playersOverview(ids, fx);

  res.json({
    total,
    offset,
    limit,
    players: page.map((c) => {
      const w = agg.wallet.get(c.id);
      const v = agg.vault.get(c.id);
      const s = agg.state.get(c.id);
      const name =
        [c.first_name, c.last_name].filter(Boolean).join(' ') || null;
      return {
        id: c.id,
        email: c.email,
        name,
        phone: c.phone ?? null,
        groups: (c.groups ?? []).map((g) => g.name),
        vip_level: agg.vipLevel.get(c.id) ?? 1,
        wallet_balance: (w?.balanceCents ?? 0) / 100,
        vault_value: (v?.cents ?? 0) / 100,
        vault_count: v?.count ?? 0,
        total_spend: (w?.vipSpendCents ?? 0) / 100,
        total_pulls: agg.pullCount.get(c.id) ?? 0,
        registered_at: c.created_at,
        last_spend_at: w?.lastSpendAt ?? null,
        frozen: s?.frozen ?? false,
        disabled: s?.disabled ?? false,
        // No state row at all = never verified, which is the default for every
        // account that predates the gate.
        phone_verified: s?.phoneVerified ?? false,
      };
    }),
  });
}

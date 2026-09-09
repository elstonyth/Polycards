import type {
  AuthenticatedMedusaRequest,
  MedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError, Modules } from '@medusajs/framework/utils';
import type { ICustomerModuleService } from '@medusajs/framework/types';
import { PACKS_MODULE } from '../../../modules/packs';
import type PacksModuleService from '../../../modules/packs/service';
import { resolveFxRate } from '../../../modules/packs/pricing';
import { isPartnerGroup } from '../../../modules/packs/group-policy';
import { effectivePlayerGroup } from '../../../modules/packs/odds-sets';
import {
  mintPartnerAccount,
  type PartnerAccountRow,
} from '../../../utils/partner-accounts';
import { isValidUsername } from '../../../utils/profile-handle';
import { CHARSET_MESSAGE } from '../../utils/username-guard';
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
      // Partner source (spec 2026-09-09): 'group' when the effective player
      // group — the same choice resolvePlayerGroup makes — is a partner group,
      // else 'manual' for the per-customer flag. Group first because the
      // group's rate is the one that pays them.
      const effective = effectivePlayerGroup(c.groups ?? []);
      const partner =
        effective && isPartnerGroup(effective)
          ? 'group'
          : s?.partnerBp != null
            ? 'manual'
            : null;
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
        partner,
        // Named so the list can say WHICH group — groups[0] is whichever
        // membership Medusa returned first, not the effective one.
        partner_group: partner === 'group' ? (effective?.name ?? null) : null,
      };
    }),
  });
}

type CreateBody = {
  count?: unknown;
  display_name?: unknown;
  group_id?: unknown;
};

const MAX_BATCH = 50;

/**
 * POST /admin/players — the partner account generator.
 *
 * Body `{ count?, display_name?, group_id? }`: mints `count` (1–50, default
 * 1) login-able accounts with generated emails and passwords, files each into
 * `group_id` (null/omitted = DEFAULT, same contract as
 * POST /admin/customers/:id/group) and answers with every credential — the
 * same rows GET /admin/players/export serves later. `display_name` is
 * optional: blank = auto ("Collector####"); typed = validated and must be
 * free, then account #1 gets it exactly and the rest of the batch get
 * numbered variants (claimUsername's rule).
 *
 * Sequential, no batch rollback: accounts minted before a failure stay (they
 * are valid logins, visible in the list and the export); the operator sees
 * the error and generates the remainder. utils/partner-accounts.ts owns the
 * per-account unwind.
 */
export async function POST(
  req: AuthenticatedMedusaRequest<CreateBody>,
  res: MedusaResponse,
): Promise<void> {
  const body = req.body ?? {};
  const count = body.count === undefined ? 1 : body.count;
  if (
    typeof count !== 'number' ||
    !Number.isInteger(count) ||
    count < 1 ||
    count > MAX_BATCH
  ) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `count must be an integer between 1 and ${MAX_BATCH}.`,
    );
  }
  const rawName = body.display_name;
  if (
    rawName !== undefined &&
    rawName !== null &&
    typeof rawName !== 'string'
  ) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'display_name must be a string or null.',
    );
  }
  const displayName =
    typeof rawName === 'string' && rawName.trim() !== ''
      ? rawName.trim()
      : null;
  if (displayName !== null && !isValidUsername(displayName)) {
    throw new MedusaError(MedusaError.Types.INVALID_DATA, CHARSET_MESSAGE);
  }
  const rawGroup = body.group_id;
  if (
    rawGroup !== undefined &&
    rawGroup !== null &&
    typeof rawGroup !== 'string'
  ) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'group_id must be a string or null.',
    );
  }
  const groupId =
    typeof rawGroup === 'string' && rawGroup.trim() !== ''
      ? rawGroup.trim()
      : null;

  // 404 on a bad group and 422 on a taken name BEFORE any write — after the
  // first account exists, either would leave a half-minted batch behind.
  const customers = req.scope.resolve<ICustomerModuleService>(Modules.CUSTOMER);
  if (groupId) {
    await customers.retrieveCustomerGroup(groupId, { select: ['id'] });
  }
  if (displayName !== null) {
    const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
    if (await packs.findCustomerIdByUsername(displayName)) {
      // DUPLICATE_ERROR, not CONFLICT: Medusa's error handler replaces
      // CONFLICT's message with idempotency-key advice (username-guard.ts).
      throw new MedusaError(
        MedusaError.Types.DUPLICATE_ERROR,
        'That display name is already taken.',
      );
    }
  }

  const players: PartnerAccountRow[] = [];
  for (let i = 0; i < count; i++) {
    players.push(await mintPartnerAccount(req.scope, { displayName, groupId }));
  }
  res.status(201).json({ players });
}

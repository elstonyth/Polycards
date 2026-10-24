import type {
  AuthenticatedMedusaRequest,
  MedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError, Modules } from '@medusajs/framework/utils';
import type {
  FilterableCustomerProps,
  ICustomerModuleService,
} from '@medusajs/framework/types';
import { PACKS_MODULE } from '../../../modules/packs';
import type PacksModuleService from '../../../modules/packs/service';
import {
  PLAYER_SORTS,
  type PlayerSort,
} from '../../../modules/packs/service';
import { resolveFxRate } from '../../../modules/packs/pricing';
import { STATS_RANGES, statsWindows } from '../../../modules/packs/stats';
import { isPartnerGroup } from '../../../modules/packs/group-policy';
import {
  effectivePlayerGroup,
  isDefaultPlayerGroup,
} from '../../../modules/packs/odds-sets';
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

// Sortable columns are an allowlist, not a passthrough. Two query shapes:
// created_at, email and name are real `customer` columns that go straight
// into the customer query builder (`name` = first_name + last_name, in that
// order). PLAYER_SORTS are ordered in SQL over every matching player by
// playerIdsSorted: the ledger money totals (operator request, 2026-10-09),
// and since 2026-10-23 every other column too: vault, VIP level, effective
// group, status, and phone (there so a missing phone sorts last both ways).
const SORTABLE = new Set(['created_at', 'email', 'name', ...PLAYER_SORTS]);

// ?range= takes the Dashboard's presets, plus all time (the default).
const RANGES = ['all', ...STATS_RANGES] as const;

const str = (v: unknown): string | undefined =>
  typeof v === 'string' ? v : undefined;

// ponytail: a search sorted by a SQL-sorted column orders at most this many
// matches; page the search in SQL if a search ever matches more players.
const MAX_SORTED_MATCHES = 5000;

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

  // ?group= (spec 2026-10-14-admin-finance-pages §8): `default` is everyone
  // outside a non-default group (the odds engine's rule, so ungrouped counts);
  // a group id is that group's members. Anything else is refused, not ignored:
  // a dropped filter would list every player as if it matched.
  const rawGroup = req.query.group;
  if (
    rawGroup !== undefined &&
    rawGroup !== '' &&
    (typeof rawGroup !== 'string' ||
      !(rawGroup === 'default' || /^cusgroup_[A-Za-z0-9]+$/.test(rawGroup)))
  ) {
    // The input is not echoed back: say what is accepted instead.
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'Invalid `group` filter: use `default` or a customer group id.',
    );
  }
  let group = typeof rawGroup === 'string' && rawGroup ? rawGroup : null;

  // ?range= (2026-10-23): top-up, withdraw, contribution and turnover count
  // only that window's ledger rows (the Stats windows: MYT, half-open);
  // wallet, vault, level and status stay as of now. A repeated or unknown
  // range is refused, never read as all time.
  const rawRange = req.query.range;
  if (rawRange !== undefined && typeof rawRange !== 'string') {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `range must be one of ${RANGES.join(', ')}.`,
    );
  }
  const range = rawRange || 'all';
  const windows =
    range === 'all'
      ? null
      : statsWindows(range, new Date(), str(req.query.from), str(req.query.to));
  if (range !== 'all' && !windows) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `range must be one of ${RANGES.join(', ')}; custom needs from <= to as YYYY-MM-DD, starting no later than today.`,
    );
  }
  const window = windows?.current ?? null;

  const customers = req.scope.resolve<ICustomerModuleService>(Modules.CUSTOMER);
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);

  // The DEFAULT group's own id means `default` (everyone outside a
  // non-default group, ungrouped included), never "its stored members":
  // every sign-up joins it, so that list would be every customer. A group
  // that is gone (or never was) has no members to list.
  if (group && group !== 'default') {
    const [found] = await customers.listCustomerGroups(
      { id: group },
      { select: ['id', 'name', 'metadata'] },
    );
    if (!found) {
      res.json({ total: 0, offset, limit, window, players: [] });
      return;
    }
    if (isDefaultPlayerGroup(found)) group = 'default';
  }

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

  // Medusa's `q` only searches the customer's own columns (email, name, phone),
  // so the profile handle — metadata.handle, the "@Collector…" a player copies
  // from their profile and sends to support — matched nobody. An exact handle
  // (leading "@" allowed) ADDS that player to what `q` matches, never replaces
  // it: handles were frozen from display names (Migration20260930140000), so
  // many are plain words, and "lee" must still list every Lee.
  // ponytail: the union takes at most 1000 text matches; page it in SQL if an
  // exact-handle search ever matches more players than that.
  const handle = q?.replace(/^@/, '').trim();
  const byHandle =
    handle && isValidUsername(handle)
      ? await packs.findCustomerIdByHandle(handle)
      : null;
  const textIds = byHandle
    ? (
        await customers.listCustomers({ q }, { select: ['id'], take: 1000 })
      ).map((c) => c.id)
    : [];

  // ponytail: to-many `groups` join under skip/take — Medusa paginates on the
  // customer, and players-list.spec.ts pages limit=1 with a grouped customer in
  // the set, so this holds; revisit only if a page ever short-counts.
  let filters: { id?: string[] | { $nin: string[] }; q?: string } = byHandle
    ? { id: [...new Set([byHandle, ...textIds])] }
    : q
      ? { q }
      : {};
  // The group narrows whatever the search matched.
  const include =
    group && group !== 'default' ? await packs.groupMemberIds(group) : null;
  const exclude =
    group === 'default' ? new Set(await packs.nonDefaultMemberIds()) : null;
  if (include) {
    const members = new Set(include);
    filters = Array.isArray(filters.id)
      ? { id: filters.id.filter((id) => members.has(id)) }
      : { ...filters, id: include };
  } else if (exclude && exclude.size > 0) {
    filters = Array.isArray(filters.id)
      ? { id: filters.id.filter((id) => !exclude.has(id)) }
      : { ...filters, id: { $nin: [...exclude] } };
  }
  // $nin is a real operator in Medusa's filter layer; its public type only
  // declares the plain forms.
  const customerFilters = filters as FilterableCustomerProps;
  if (Array.isArray(filters.id) && filters.id.length === 0) {
    res.json({ total: 0, offset, limit, window, players: [] });
    return;
  }
  // Before the page: the vault sort orders by the value shown at this rate.
  const fx = await resolveFxRate(packs);
  const [page, total] = PLAYER_SORTS.has(sortKey)
    ? await sqlSortedPage()
    : await customers.listAndCountCustomers(customerFilters, {
        skip: offset,
        take: limit,
        order,
        relations: ['groups'],
      });

  // The same filters, ordered in SQL: the sorted ids come from SQL, then the
  // customers are loaded and put back in that order.
  async function sqlSortedPage() {
    // An explicit id list (a handle match, or a group's members) is the
    // scope; a text search resolves to its matches, the group included.
    const scope = filters.q
      ? (
          await customers.listCustomers(customerFilters, {
            select: ['id'],
            take: MAX_SORTED_MATCHES,
          })
        ).map((c) => c.id)
      : Array.isArray(filters.id)
        ? filters.id
        : null;
    const sorted = await packs.playerIdsSorted({
      key: sortKey as PlayerSort,
      dir: sortDir,
      ids: scope,
      excludeIds: exclude ? [...exclude] : undefined,
      window,
      fx,
      limit,
      offset,
    });
    const rows = sorted.ids.length
      ? await customers.listCustomers(
          { id: sorted.ids },
          { take: sorted.ids.length, relations: ['groups'] },
        )
      : [];
    const byId = new Map(rows.map((c) => [c.id, c]));
    return [
      sorted.ids.flatMap((id) => byId.get(id) ?? []),
      sorted.total,
    ] as const;
  }
  const ids = page.map((c) => c.id);
  const agg = await packs.playersOverview(ids, fx, window);

  res.json({
    total,
    offset,
    limit,
    // The ?range= window the period columns cover; null = all time.
    window,
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
        // The EFFECTIVE player group (the odds engine's rule), null = the
        // default group; groups[0] is just whichever membership came first.
        player_group: effective?.name ?? null,
        vip_level: agg.vipLevel.get(c.id) ?? 1,
        wallet_balance: (w?.balanceCents ?? 0) / 100,
        vault_value: (v?.cents ?? 0) / 100,
        vault_count: v?.count ?? 0,
        total_spend: (w?.vipSpendCents ?? 0) / 100,
        // Top-ups, withdrawals, and what the player has put in net of what
        // they took out (top-ups minus withdrawals): lifetime, or over
        // ?range=, as total_spend is.
        total_topup: (w?.topupCents ?? 0) / 100,
        total_withdrawn: (w?.withdrawnCents ?? 0) / 100,
        total_contribution:
          ((w?.topupCents ?? 0) - (w?.withdrawnCents ?? 0)) / 100,
        total_pulls: agg.pullCount.get(c.id) ?? 0,
        registered_at: c.created_at,
        last_spend_at: w?.lastSpendAt ?? null,
        frozen: s?.frozen ?? false,
        disabled: s?.disabled ?? false,
        // No state row at all = never verified, which is the default for every
        // account that predates the gate.
        phone_verified: s?.phoneVerified ?? false,
        // Spec 2026-10-06: what staff check against Touch 'n Go.
        real_name: s?.realName ?? null,
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
    players.push(
      await mintPartnerAccount(req.scope, {
        displayName,
        groupId,
        adminId: req.auth_context.actor_id,
      }),
    );
  }
  res.status(201).json({ players });
}

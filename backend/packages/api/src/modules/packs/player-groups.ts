import { MedusaError, Modules } from '@medusajs/framework/utils';
import type {
  CustomerGroupDTO,
  ICustomerModuleService,
  MedusaContainer,
} from '@medusajs/framework/types';
import {
  coerceOddsSet,
  DEFAULT_PLAYER_GROUP_FLAG,
  DEFAULT_PLAYER_GROUP_NAME,
  isDefaultPlayerGroup,
  type OddsSet,
} from './odds-sets';
import { configAuditRow } from './config-audit';
import {
  groupPolicyOf,
  PARTNER_RATE_KEY,
  VERIFICATION_EXEMPT_KEY,
  WITHDRAWALS_BLOCKED_KEY,
  type GroupPolicy,
} from './group-policy';
import { PACKS_MODULE } from './index';
import type PacksModuleService from './service';

/**
 * Player groups ARE Medusa customer groups — one row, two names. The admin
 * surface calls them "player groups" because that is the operator's word for
 * them, and each one carries the odds set its members roll on
 * (`metadata.odds_set`, read by resolveOddsSetForCustomer).
 *
 * Everything here treats membership as EXCLUSIVE: a player is in exactly one
 * group. Medusa's own model is many-to-many and the prebuilt /customer-groups
 * screen can still put someone in two, which resolveOddsSetForCustomer handles
 * — but every write on OUR surfaces goes through setPlayerGroup, so the
 * "which group's odds?" question never has two answers in practice.
 */

const customerService = (container: MedusaContainer) =>
  container.resolve<ICustomerModuleService>(Modules.CUSTOMER);

// The whole group list, not a name filter. Identity is the metadata MARKER
// (see DEFAULT_PLAYER_GROUP_FLAG) precisely because the name can be changed on
// the prebuilt /customer-groups screen, and a filtered query keyed on the name
// would miss a renamed row and happily create a second default beside it.
// Bounded by the same 100-group ceiling the admin list assumes.
const listGroups = (container: MedusaContainer) =>
  customerService(container).listCustomerGroups(
    {},
    { take: 100, order: { created_at: 'ASC' } },
  );

/** The default group by NAME, straight from the DB — the one lookup that does
 *  not depend on the 100-row window above. */
const findByName = async (container: MedusaContainer) => {
  const [row] = await customerService(container).listCustomerGroups(
    { name: DEFAULT_PLAYER_GROUP_NAME },
    { take: 1 },
  );
  return row;
};

/**
 * The default player group, created on first use.
 *
 * Members of it roll set 1 — the same odds as having no group at all — so it
 * is purely a label the operator can see and move players out of.
 * resolveOddsSetForCustomer enforces that regardless of what this row's
 * `odds_set` says, and the admin locks its odds-set control to match.
 *
 * Self-healing on the name: a production row that predates the marker is
 * ADOPTED (stamped) rather than duplicated, so the group the operator already
 * sees stays the one the code uses.
 *
 * `name` is UNIQUE in the customer-group model, so two concurrent sign-ups
 * race on the create: the loser's insert throws and re-reads the winner's row
 * rather than leaving the customer group-less.
 */
export async function ensureDefaultPlayerGroup(
  container: MedusaContainer,
): Promise<CustomerGroupDTO> {
  const customers = customerService(container);
  const groups = await listGroups(container);

  const marked = groups.find(
    (g) => g.metadata?.[DEFAULT_PLAYER_GROUP_FLAG] === true,
  );
  if (marked) return marked;

  // Name lookup goes to the DB, not to the page above. The marker scan is
  // window-bounded (metadata is not a server-side filter), so on a shop with
  // more than 100 groups the default row can fall outside it — and then a
  // page-only name check would miss it, the create below would hit the unique
  // name constraint, and every move would 500.
  const byName = await findByName(container);
  if (byName) {
    // Pre-marker row (or a fresh clone of production): adopt it. Medusa merges
    // metadata per key on update, so `odds_set` and anything else on the row
    // survives this stamp.
    return await customers.updateCustomerGroups(byName.id, {
      metadata: { [DEFAULT_PLAYER_GROUP_FLAG]: true },
    });
  }

  try {
    return await customers.createCustomerGroups({
      name: DEFAULT_PLAYER_GROUP_NAME,
      metadata: { odds_set: 1, [DEFAULT_PLAYER_GROUP_FLAG]: true },
    });
  } catch (e) {
    // Same reason the lookup above is name-filtered: the winner of a create
    // race must be findable regardless of where it sits in the group list.
    const raced =
      (await findByName(container)) ??
      (await listGroups(container)).find(isDefaultPlayerGroup);
    if (raced) return raced;
    throw e;
  }
}

/**
 * Move a player into exactly one group, clearing every other membership.
 *
 * Exclusive on purpose: the operator's mental model is "this player's group",
 * singular, and leaving a stale second membership behind would let the older
 * group's odds win silently (see resolveOddsSetForCustomer). `groupId` null
 * means "back to the default group" — never "no group", so the Players list
 * never shows a blank cell after a move.
 *
 * Returns the group the player ended up in.
 *
 * Audited against the customer (action 'set_player_group') with the groups
 * and odds sets before and after, so which odds a player rolled at any past
 * moment can be read back. Two modules, so no shared transaction: the
 * membership writes land first and the audit row second — a failed audit
 * surfaces as a 500 the operator sees (same stance as editGroupPolicy).
 */
export async function setPlayerGroup(
  container: MedusaContainer,
  customerId: string,
  groupId: string | null,
  adminId: string,
): Promise<CustomerGroupDTO> {
  const customers = customerService(container);

  // Fail BEFORE any write if the customer does not exist: retrieveCustomer
  // throws a clean 404, where letting it fall through to addCustomerToGroup
  // surfaces a raw foreign-key error as a 500.
  await customers.retrieveCustomer(customerId, { select: ['id'] });

  const target = groupId
    ? await customers.retrieveCustomerGroup(groupId)
    : await ensureDefaultPlayerGroup(container);

  const current = await customers.listCustomerGroups({
    customers: customerId,
  });

  // Add FIRST, remove second: if the remove half fails the player is in two
  // groups (recoverable — the admin's group card leaves Save enabled while a
  // player holds more than one membership, and resolveOddsSetForCustomer keeps
  // preferring the real group over the default one). The other order can leave
  // them in none. Deliberately NOT swallowed into a 200: a stale membership can
  // change which odds set the player rolls, so the operator has to see it fail
  // and retry. Retrying is safe — the add is skipped when already a member.
  if (!current.some((g) => g.id === target.id)) {
    await customers.addCustomerToGroup({
      customer_id: customerId,
      customer_group_id: target.id,
    });
  }

  const stale = current.filter((g) => g.id !== target.id);
  if (stale.length > 0) {
    await customers.removeCustomerFromGroup(
      stale.map((g) => ({
        customer_id: customerId,
        customer_group_id: g.id,
      })),
    );
  }

  const added = !current.some((g) => g.id === target.id);
  if (added || stale.length > 0) {
    const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
    await packs.createAdminActionAudits([
      configAuditRow({
        adminId,
        entityType: 'customer',
        entityId: customerId,
        action: 'set_player_group',
        before: { groups: current.map(groupRecord) },
        after: { group: groupRecord(target) },
      }),
    ]);
  }

  return target;
}

/** The odds set a group's members actually roll — DEFAULT is always set 1,
 *  whatever its row says (resolveOddsSetForCustomer's rule). */
const rolledOddsSet = (g: CustomerGroupDTO): OddsSet =>
  isDefaultPlayerGroup(g) ? 1 : coerceOddsSet(g.metadata?.odds_set);

const groupRecord = (g: CustomerGroupDTO) => ({
  id: g.id,
  name: g.name,
  odds_set: rolledOddsSet(g),
});

/**
 * Change the odds set a player group's members roll. The one audited writer of
 * `metadata.odds_set` on an existing group: the native update route refuses
 * that key (rejectGroupOddsSetUpdate), so every change leaves a before/after
 * row. The DEFAULT group is refused — its members always roll set 1.
 */
export async function editGroupOddsSet(
  container: MedusaContainer,
  input: { groupId: string; oddsSet: OddsSet; adminId: string },
): Promise<CustomerGroupDTO> {
  if (![1, 2, 3].includes(input.oddsSet)) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'Odds set must be 1, 2 or 3.',
    );
  }
  const customers = customerService(container);
  const group = await customers.retrieveCustomerGroup(input.groupId);
  if (isDefaultPlayerGroup(group)) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'The default player group always rolls odds set 1. Move the players into a group of their own first.',
    );
  }
  const before = rolledOddsSet(group);
  if (before === input.oddsSet) return group;

  // Medusa merges metadata per key, so the partner policy and anything else
  // on the row survives this write.
  const updated = await customers.updateCustomerGroups(group.id, {
    metadata: { odds_set: input.oddsSet },
  });
  const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
  await packs.createAdminActionAudits([
    configAuditRow({
      adminId: input.adminId,
      entityType: 'customer_group',
      entityId: group.id,
      action: 'edit_odds_set',
      before: { odds_set: before },
      after: { odds_set: input.oddsSet },
    }),
  ]);
  return updated;
}

/**
 * Write a group's partner policy (spec 2026-09-09). Lives here, not on the
 * service, for the same reason setPlayerGroup does: the group row belongs to
 * the Customer module, which the packs module container cannot resolve.
 *
 * Rules enforced server-side, whatever the admin sent:
 *  - the DEFAULT group never carries a policy (its members must behave like
 *    ungrouped customers — same reason its odds set is locked);
 *  - a non-null rate must be an integer inside referral_settings' partner
 *    bounds, the same check setPartnerRate applies to the manual flag;
 *  - both toggles are forced OFF when the group is not a partner group, so
 *    "partner off" is one switch, not three.
 *
 * Audited against the group row (entity_type 'customer_group') with the
 * before/after policy, so the History trail explains why a player suddenly
 * could not withdraw. Two modules, so no shared transaction: the metadata
 * write lands first and the audit row second — a failed audit surfaces as a
 * 500 the operator sees, never a silent policy change.
 */
export async function editGroupPolicy(
  container: MedusaContainer,
  input: {
    groupId: string;
    policy: GroupPolicy;
    adminId: string;
    reason: string;
  },
): Promise<CustomerGroupDTO> {
  const customers = customerService(container);
  const packs = container.resolve<PacksModuleService>(PACKS_MODULE);

  // 404 on a missing group before any validation reads.
  const group = await customers.retrieveCustomerGroup(input.groupId);
  if (isDefaultPlayerGroup(group)) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'The default player group cannot be a partner group. Move the players into a group of their own first.',
    );
  }

  const rate = input.policy.partner_rate_bp;
  if (rate !== null) {
    const { partner_min_bp, partner_max_bp } =
      await packs.getReferralSettings();
    if (
      !Number.isInteger(rate) ||
      rate < partner_min_bp ||
      rate > partner_max_bp
    ) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `Partner rate must be an integer between ${partner_min_bp} and ${partner_max_bp} bp.`,
      );
    }
  }
  const next: GroupPolicy =
    rate === null
      ? {
          partner_rate_bp: null,
          withdrawals_blocked: false,
          verification_exempt: false,
        }
      : {
          partner_rate_bp: rate,
          withdrawals_blocked: input.policy.withdrawals_blocked === true,
          verification_exempt: input.policy.verification_exempt === true,
        };

  const before = groupPolicyOf(group);
  // Medusa merges metadata per key (mergeMetadata: null is stored, only ''
  // deletes), so odds_set and the default marker on the row survive this.
  const updated = await customers.updateCustomerGroups(group.id, {
    metadata: {
      [PARTNER_RATE_KEY]: next.partner_rate_bp,
      [WITHDRAWALS_BLOCKED_KEY]: next.withdrawals_blocked,
      [VERIFICATION_EXEMPT_KEY]: next.verification_exempt,
    },
  });
  await packs.createAdminActionAudits([
    {
      admin_id: input.adminId,
      entity_type: 'customer_group',
      entity_id: group.id,
      action: 'edit_group_policy',
      before,
      after: next,
      reason: input.reason,
    },
  ]);
  return updated;
}

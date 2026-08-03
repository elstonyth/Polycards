import { Modules } from '@medusajs/framework/utils';
import type {
  CustomerGroupDTO,
  ICustomerModuleService,
  MedusaContainer,
} from '@medusajs/framework/types';
import {
  DEFAULT_PLAYER_GROUP_FLAG,
  DEFAULT_PLAYER_GROUP_NAME,
  isDefaultPlayerGroup,
} from './odds-sets';

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

  // Pre-marker row (or a fresh clone of production): adopt it. Medusa merges
  // metadata per key on update, so `odds_set` and anything else on the row
  // survives this stamp.
  const byName = groups.find((g) => g.name === DEFAULT_PLAYER_GROUP_NAME);
  if (byName) {
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
    const raced = (await listGroups(container)).find(isDefaultPlayerGroup);
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
 */
export async function setPlayerGroup(
  container: MedusaContainer,
  customerId: string,
  groupId: string | null,
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

  return target;
}

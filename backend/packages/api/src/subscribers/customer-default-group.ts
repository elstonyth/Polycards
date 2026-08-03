import { SubscriberArgs, type SubscriberConfig } from '@medusajs/framework';
import { Modules } from '@medusajs/framework/utils';
import type { ICustomerModuleService } from '@medusajs/framework/types';
import { ensureDefaultPlayerGroup } from '../modules/packs/player-groups';

/**
 * Every new player lands in the DEFAULT player group.
 *
 * Odds-wise this changes nothing — DEFAULT plays set 1, which is what a
 * group-less customer already rolled. It exists so the admin's Players list and
 * Player Groups page never show an ungrouped player: the operator asked to be
 * able to MOVE a player between groups, and "move from nothing" is not a thing
 * the UI can express.
 *
 * Fires for the paths that go through createCustomersWorkflow — storefront
 * register, Google OAuth, the admin — because that workflow is what emits this
 * event. NOT the seed: scripts/seed.ts calls customerModuleService
 * .createCustomers directly, which emits nothing; seeded customers are covered
 * by scripts/backfill-default-group.ts instead.
 *
 * Never throws: a group assignment is cosmetic, and a rejection here would
 * retry-loop the event bus over an account that already exists.
 */
export default async function customerDefaultGroupHandler({
  event: { data },
  container,
}: SubscriberArgs<{ id: string } | { id: string }[]>) {
  const logger = container.resolve('logger');
  // emitEventStep is handed an ARRAY by createCustomersWorkflow. The bus
  // normally fans that out to one event per item, but handling both shapes
  // costs one line and a bulk create must not silently skip everyone but one.
  const ids = (Array.isArray(data) ? data : [data])
    .map((d) => d?.id)
    .filter((id): id is string => typeof id === 'string' && id !== '');
  if (ids.length === 0) return;

  try {
    const group = await ensureDefaultPlayerGroup(container);
    const customers = container.resolve<ICustomerModuleService>(
      Modules.CUSTOMER,
    );
    // Seeds and bulk imports can replay this event for customers already in the
    // group; adding a duplicate pair would violate the pivot's unique index.
    const already = new Set(
      (
        await customers.listCustomerGroupCustomers({
          customer_group_id: group.id,
          customer_id: ids,
        })
      ).map((row) => row.customer_id),
    );
    const pairs = ids
      .filter((id) => !already.has(id))
      .map((id) => ({ customer_id: id, customer_group_id: group.id }));
    if (pairs.length > 0) await customers.addCustomerToGroup(pairs);
  } catch (e) {
    logger.warn(
      `[customer-default-group] could not assign ${ids.length} customer(s) to the default group: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
}

export const config: SubscriberConfig = {
  event: 'customer.created',
};

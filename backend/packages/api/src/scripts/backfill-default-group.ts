/**
 * backfill-default-group.ts
 *
 * One-shot: put every existing player in the DEFAULT player group.
 *
 * The customer.created subscriber only covers accounts made AFTER it shipped,
 * so without this the Player Groups page reports "DEFAULT — 0 players" on a
 * live shop and the operator cannot tell the feature works. Odds are unchanged
 * either way: DEFAULT plays set 1, which is what an ungrouped customer already
 * rolled.
 *
 * Players who already belong to a group (e.g. "pro") are LEFT ALONE — this
 * fills the empty cells, it never moves anyone.
 *
 * RUN (backend must be up):
 *   corepack yarn medusa exec ./src/scripts/backfill-default-group.ts
 *
 * Idempotent: a second run assigns 0.
 */
import { ExecArgs } from '@medusajs/framework/types';
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils';
import type { ICustomerModuleService } from '@medusajs/framework/types';
import { ensureDefaultPlayerGroup } from '../modules/packs/player-groups';

const PAGE = 500;

export default async function backfillDefaultGroup({
  container,
}: ExecArgs): Promise<void> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const customers = container.resolve<ICustomerModuleService>(Modules.CUSTOMER);

  const group = await ensureDefaultPlayerGroup(container);
  logger.info(
    `[backfill-default-group] target group ${group.name} (${group.id})`,
  );

  let skip = 0;
  let scanned = 0;
  let assigned = 0;
  let total = 0;

  // Paged with a stable order so a page boundary can't skip a row. `groups` is
  // a to-many join under skip/take — the same shape the players list already
  // relies on (see api/admin/players/route.ts).
  //
  // listAndCount, not list: this is a manual one-shot on production, so the
  // operator needs the run to PROVE it covered everyone. Looping to a known
  // total and logging scanned-vs-total turns "it printed Done" into a real
  // completeness check; an early break on a short page could not.
  for (;;) {
    const [page, count] = await customers.listAndCountCustomers(
      {},
      {
        skip,
        take: PAGE,
        order: { created_at: 'ASC', id: 'ASC' },
        relations: ['groups'],
      },
    );
    total = count;
    if (page.length === 0) break;
    scanned += page.length;

    const pairs = page
      .filter((c) => (c.groups ?? []).length === 0)
      .map((c) => ({ customer_id: c.id, customer_group_id: group.id }));
    if (pairs.length > 0) {
      await customers.addCustomerToGroup(pairs);
      assigned += pairs.length;
    }

    skip += PAGE;
    if (skip >= total) break;
  }

  logger.info(
    `[backfill-default-group] scanned ${scanned}/${total} customer(s), assigned ${assigned} to ${group.name}. Done.`,
  );
  if (scanned < total) {
    logger.warn(
      `[backfill-default-group] INCOMPLETE — ${total - scanned} customer(s) were not scanned. Re-run.`,
    );
  }
}

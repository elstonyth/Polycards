/**
 * backfill-customer-feed-channel.ts
 *
 * One-shot backfill for the customer-feed channel split. Customer in-app
 * notifications used to be written on channel 'feed' — the channel the Medusa
 * admin dashboard's own bell drawer lists. The drawer renders null for any row
 * without a data.title, and our payloads are domain primitives, so every
 * customer row rendered as nothing: the drawer never showed content and never
 * reached its empty state either, so it read as "loading forever".
 *
 * The code now writes CUSTOMER_FEED_CHANNEL; this moves the rows already in the
 * table. Scoped to rows that carry a receiver_id (every customer notification
 * sets it, and the admin dashboard's own feed rows do not), so a genuine admin
 * feed row is never moved.
 *
 * RUN (backend must be up), in the same window as the deploy that ships the
 * channel split — until it runs, historical customer notifications are absent
 * from /notifications and still blanking the admin drawer:
 *   corepack yarn medusa exec ./src/scripts/backfill-customer-feed-channel.ts
 *
 * Idempotent: only rows still on 'feed' are touched, so a second run moves 0.
 */
import { ExecArgs } from '@medusajs/framework/types';
import { ContainerRegistrationKeys } from '@medusajs/framework/utils';
import { CUSTOMER_FEED_CHANNEL } from '../modules/packs/notify-feed';

export default async function backfillCustomerFeedChannel({
  container,
}: ExecArgs): Promise<void> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION);

  // Raw SQL on purpose: `notification` belongs to the core notification module,
  // which exposes no update API for it (createNotifications only). The channel
  // column is plain text, so this is a straight relabel of existing rows.
  const result = await knex.raw(
    `UPDATE notification
        SET channel = ?
      WHERE channel = 'feed'
        AND receiver_id IS NOT NULL`,
    [CUSTOMER_FEED_CHANNEL],
  );

  const moved = result?.rowCount ?? 0;
  logger.info(
    `[backfill-customer-feed-channel] Moved ${moved} customer notification(s) to '${CUSTOMER_FEED_CHANNEL}'. Done.`,
  );
}

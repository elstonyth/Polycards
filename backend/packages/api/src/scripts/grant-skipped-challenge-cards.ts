/**
 * grant-skipped-challenge-cards.ts
 *
 * Hand over the Weekly-Challenge prize cards that older settlements refused
 * because the card was out of stock. The stock gate is gone (2026-08-17) —
 * stock is a fulfilment counter everywhere else in this codebase and is now a
 * counter here too — but the weeks it already skipped do NOT self-heal:
 * settleChallengeWeek's re-entry gate is per CUSTOMER, so a winner paid credits
 * and denied a card is permanently outside it.
 *
 * RUN (DB reachable):
 *   corepack yarn medusa exec ./src/scripts/grant-skipped-challenge-cards.ts
 *   corepack yarn medusa exec ./src/scripts/grant-skipped-challenge-cards.ts 2026-08-10
 *
 * The optional argument is a week_start (any Date-parseable form; bare
 * YYYY-MM-DD is read as UTC midnight, which is what challenge_payout stores
 * only if the reset hour is UTC midnight — prefer the exact ISO string from the
 * admin Winners tab when narrowing). Omitted, every outstanding row is granted.
 *
 * Idempotent: rows flip to `granted`, so a second run finds nothing. Stock is
 * decremented for each grant and may go negative — that negative IS the units
 * owed to winners that still need sourcing.
 *
 * Silent by design: the winners were already notified at settlement (same
 * idempotency key), so the cards simply appear in their vaults.
 */
import { ExecArgs } from '@medusajs/framework/types';
import { ContainerRegistrationKeys } from '@medusajs/framework/utils';
import PacksModuleService from '../modules/packs/service';
import { PACKS_MODULE } from '../modules/packs';
import { takeCardStock } from '../modules/packs/card-stock';

export default async function grantSkippedChallengeCards({
  container,
  args,
}: ExecArgs): Promise<void> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const packs = container.resolve<PacksModuleService>(PACKS_MODULE);

  const raw = args?.[0];
  const weekStart = raw ? new Date(raw) : undefined;
  if (weekStart && Number.isNaN(weekStart.getTime())) {
    logger.error(`[grant-skipped-challenge-cards] unparseable week: ${raw}`);
    return;
  }

  const result = await packs.grantSkippedChallengeCards({
    weekStart,
    decrementStock: takeCardStock(container),
  });

  logger.info(
    `[grant-skipped-challenge-cards] ${JSON.stringify(result, null, 2)}`,
  );
  if (result.stillSkipped.length > 0) {
    // The only skip the status can still mean: the prize Card row is gone, so
    // there is no handle to mint a pull against. Manual fulfilment, for real
    // this time.
    logger.warn(
      `[grant-skipped-challenge-cards] ${result.stillSkipped.length} row(s) left skipped — their prize card no longer exists: ${result.stillSkipped.join(', ')}`,
    );
  }
}

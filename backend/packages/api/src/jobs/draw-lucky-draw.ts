import { MedusaContainer } from '@medusajs/framework/types';
import { ContainerRegistrationKeys } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../modules/packs';
import { takeCardStock } from '../modules/packs/card-stock';
import type PacksModuleService from '../modules/packs/service';

/**
 * Lucky Draw: every minute, draw each prize whose draw time has passed (spec
 * 2026-10-24 §6). Each prize draws, pays and writes its result in its own
 * transaction under the prize lock, and the result row is unique per prize,
 * so overlapping or repeated runs cannot draw twice. A prize that fails stays
 * due and is retried next minute; the per-prize reason is logged by the
 * service (e.g. "LUCKY_DRAW_SEED_SECRET changed since publish").
 *
 * A one_winner event (spec 2026-10-30) draws once at its end, in one transaction
 * that pays every prize to the one winner or nothing at all, with the event result
 * unique per event. It stays due and retries the same way.
 */
export default async function drawLuckyDrawJob(container: MedusaContainer) {
  const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
  const warn = (message: string) => {
    try {
      container.resolve(ContainerRegistrationKeys.LOGGER).warn(message);
    } catch {
      // logger unavailable in test containers — ignore
    }
  };

  const decrementStock = takeCardStock(container);
  const events = await packs.drawDueLuckyDrawEvents({ decrementStock });
  if (events.failed > 0) {
    warn(
      `[draw-lucky-draw] ${events.failed} event(s) FAILED to draw, paid nothing and will be retried next minute — see the "event not drawn" warnings for why (a missing card, or a seed hash mismatch: restore the card or the secret, or withdraw the event)`,
    );
  }

  const { failed } = await packs.drawDueLuckyDrawPrizes({
    decrementStock,
    onDrawn: async (o) => {
      // A card prize whose Card row is gone: the winner is recorded but
      // nothing was minted. This line is what puts it in front of an operator.
      if (o.kind === 'card' && o.winnerId && !o.pullId) {
        warn(
          `[draw-lucky-draw] prize card missing, NOT granted (manual fulfilment): prize ${o.prizeId} winner ${o.winnerId} card ${o.cardHandle}`,
        );
      }
    },
  });
  if (failed > 0) {
    warn(
      `[draw-lucky-draw] ${failed} prize(s) FAILED to draw and will be retried next minute — see the "prize not drawn" warnings for why (a seed hash mismatch means LUCKY_DRAW_SEED_SECRET changed since publish)`,
    );
  }
}

export const config = {
  name: 'draw-lucky-draw',
  schedule: '* * * * *', // every minute; the result row makes extra runs no-ops
};

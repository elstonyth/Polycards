import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../../modules/packs';
import type PacksModuleService from '../../../../modules/packs/service';
import {
  buybackAmount,
  FLAT_PERCENT,
} from '../../../../modules/packs/buyback-rate';
import { makeRarityOf } from '../../../../modules/packs/card-view';
import { toMoney } from '../../../../modules/packs/money';
import {
  DEFAULT_MARKET_MULTIPLIER,
  displayMarketPrice,
  resolveFxRate,
} from '../../../../modules/packs/pricing';
import { fitToFeed } from '../../../../modules/packs/feed-size';
import { renderPullCard } from '../../../../modules/packs/pull-card';
import { stripAutolinks } from '../../../../modules/packs/telegram';
import { loadPullerProfiles } from '../../../store/pulls/pullers';

// GET /reports/growth/pull-card?pull=<id>: the Telegram channel's pull card
// (pull-card.ts, the same renderer and inputs telegram.ts posts) for one paid
// pull, priced at its pulled value (the value the Ranks page and the top-pulls
// report count) with the flat vault buyback beside it. A prize draw, a free
// welcome pull or a disabled player's pull is not found, as on every public
// surface. 502 when none of the card's art can be fetched: no broken picture.
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const id = req.query.pull;
  if (typeof id !== 'string' || !/^[A-Za-z0-9_]{1,64}$/.test(id)) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'pull must be a pull id (top_pulls gives each pull_id).',
    );
  }
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const [pull] = await packs.listPulls({ id }, { take: 1 });
  const pullers =
    pull?.source === 'pack'
      ? await loadPullerProfiles(req, packs, [pull.customer_id])
      : null;
  if (!pull || !pullers || pullers.disabled.has(pull.customer_id)) {
    throw new MedusaError(MedusaError.Types.NOT_FOUND, 'No such paid pull.');
  }
  const [[card], [pack], odds, fx] = await Promise.all([
    packs.listCards({ handle: pull.card_id }, { take: 1 }),
    packs.listPacks({ slug: pull.pack_id }, { take: 1 }),
    packs.listPackOdds(
      { pack_id: pull.pack_id, card_id: pull.card_id },
      { take: 10 },
    ),
    resolveFxRate(packs),
  ]);
  if (!card) {
    throw new MedusaError(MedusaError.Types.NOT_FOUND, 'That card is gone.');
  }
  // The pulled value: the draw-time snapshot, else today's value (the same
  // COALESCE the boards use), in RM at today's rate.
  const priceMyr =
    pull.recorded_value_usd != null
      ? displayMarketPrice(toMoney(pull.recorded_value_usd), fx, 1)
      : displayMarketPrice(
          toMoney(card.market_value),
          fx,
          Number(card.market_multiplier ?? DEFAULT_MARKET_MULTIPLIER),
        );
  const who = pullers.profileOf(pull.customer_id, pull.id).who;
  const rendered = await renderPullCard(
    {
      rarity: makeRarityOf(
        odds.filter(
          (o): o is typeof o & { card_id: string } => o.card_id != null,
        ),
      )(pull.pack_id, pull.card_id),
      cardName: card.name,
      grader: card.grader ?? '',
      grade: card.grade ?? '',
      set: card.set ?? '',
      priceMyr,
      buybackMyr: buybackAmount(priceMyr, FLAT_PERCENT),
      buybackPercent: FLAT_PERCENT,
      who: stripAutolinks(who) || 'Anonymous',
      revealedAt: new Date(pull.revealed_at ?? pull.rolled_at),
      siteHost: 'polycards.gg',
    },
    {
      slab: card.slab_image ?? null,
      card: card.image ?? null,
      pack: pack?.image ?? null,
    },
  );
  if (!rendered.photo) {
    res.status(502).json({
      message:
        "The card's art could not be loaded, so the pull card was not drawn. Try again later.",
    });
    return;
  }
  res.setHeader('Content-Type', 'image/jpeg');
  // The Telegram card as drawn for the channel, fitted to the 1080x1350 feed
  // size the desk posts at (the channel itself is untouched).
  res.status(200).send(await fitToFeed(rendered.photo));
}

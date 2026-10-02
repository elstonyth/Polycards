import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../../modules/packs';
import type PacksModuleService from '../../../../modules/packs/service';
import {
  posterFigure,
  posterTextError,
  renderBrandPoster,
} from '../../../../modules/packs/brand-poster';
import { toMoney } from '../../../../modules/packs/money';
import {
  DEFAULT_MARKET_MULTIPLIER,
  displayMarketPrice,
  resolveFxRate,
} from '../../../../modules/packs/pricing';
import { pageAll } from '../../../utils/page-all';

// Categories the public catalogue never lists (store/packs/route.ts).
const UNLISTED = new Set(['reward_box', 'free_welcome']);
const METRICS = ['none', 'players', 'new_players'] as const;

// GET /reports/growth/brand-poster: a finished post graphic in the site's own
// design (brand-poster.ts) for milestones, sign-ups and announcements. The
// bot writes the words; a figure only comes from `metric`, counted live like
// the admin Stats page's sign-ups (signupTopupStats: accounts, deleted ones
// included, partner-minted ones left out), so a poster can never carry a
// number the data does not show. The hero is the three most valuable top
// hits of the public packs, as their official images.
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const q = req.query;
  const text = (name: string, max: number, required = false): string => {
    const raw = q[name];
    if (raw === undefined || raw === '') {
      if (required) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          `${name} is required.`,
        );
      }
      return '';
    }
    const error =
      typeof raw === 'string' ? posterTextError(raw, max) : 'must be text.';
    if (error) {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, `${name} ${error}`);
    }
    return (raw as string).trim();
  };
  const headline = text('headline', 60, true);
  const kicker = text('kicker', 28);
  const subline = text('subline', 120);

  const metric = q.metric ?? 'none';
  if (!METRICS.includes(metric as (typeof METRICS)[number])) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'metric must be none, players or new_players.',
    );
  }
  const rawDays = q.days ?? '3';
  if (
    typeof rawDays !== 'string' ||
    !/^\d{1,2}$/.test(rawDays) ||
    Number(rawDays) < 1 ||
    Number(rawDays) > 93
  ) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'days must be a whole number from 1 to 93.',
    );
  }
  const round = q.round ?? 'exact';
  if (round !== 'exact' && round !== 'hundred') {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'round must be exact or hundred.',
    );
  }
  const art = q.art ?? 'top_hits';
  if (art !== 'top_hits' && art !== 'none') {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'art must be top_hits or none.',
    );
  }

  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  let figure: number | null = null;
  if (metric !== 'none') {
    const to = new Date();
    const from =
      metric === 'players'
        ? new Date(0)
        : new Date(to.getTime() - Number(rawDays) * 86_400_000);
    figure = (await packs.signupTopupStats(from, to)).signups;
  }
  const hero = art === 'none' ? [] : await topHits(packs);

  const { jpeg, missing } = await renderBrandPoster(
    {
      kicker,
      headline,
      stat: figure === null ? null : posterFigure(figure, round),
      subline,
      cards: hero.map((c) => c.name),
      siteHost: 'polycards.gg',
    },
    hero.map((c) => c.image),
  );
  res.setHeader('Content-Type', 'image/jpeg');
  if (missing.length) res.setHeader('x-poster-missing-art', missing.join(','));
  if (figure !== null) res.setHeader('x-poster-figure', String(figure));
  res.status(200).send(jpeg);
}

/** The three most valuable cards among the public packs' top hits, at
 *  today's display price, each with its official image (slab first). */
export async function topHits(
  packs: PacksModuleService,
): Promise<{ name: string; image: string }[]> {
  const listed = (
    await packs.listPacks({ status: 'active' }, { take: 1000 })
  ).filter((p) => !UNLISTED.has(p.category));
  if (!listed.length) return [];
  const odds = await pageAll((opts) =>
    packs.listPackOdds(
      { pack_id: listed.map((p) => p.slug) },
      { ...opts, select: ['card_id', 'top_hit_order'] },
    ),
  );
  const handles = [
    ...new Set(
      odds
        .filter((o) => o.card_id != null && o.top_hit_order != null)
        .map((o) => o.card_id as string),
    ),
  ];
  if (!handles.length) return [];
  const cards = await packs.listCards(
    { handle: handles },
    { take: handles.length },
  );
  const fx = await resolveFxRate(packs);
  return cards
    .map((c) => ({
      name: c.name,
      image: c.slab_image ?? c.image,
      price: displayMarketPrice(
        toMoney(c.market_value),
        fx,
        toMoney(c.market_multiplier ?? DEFAULT_MARKET_MULTIPLIER),
      ),
    }))
    .filter((c) => !!c.image)
    .sort((a, b) => b.price - a.price || a.name.localeCompare(b.name))
    .slice(0, 3)
    .map(({ name, image }) => ({ name, image }));
}

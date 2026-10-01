import type { MedusaContainer } from '@medusajs/framework/types';
import { Modules } from '@medusajs/framework/utils';
import PacksModuleService from '../../../modules/packs/service';
import { PACKS_MODULE } from '../../../modules/packs';
import { publicProfileFields, seedOf } from '../../../utils/profile-handle';
import type { ChallengeRankReward } from '../../../modules/packs/challenge-validate';

// The Weekly Pulled Value Challenge view, shared by the public GET
// /store/challenge (which caches it) and the Growth desk report GET
// /reports/growth/challenge (which does not), so the two can never disagree.
// See route.ts for the challenge rules this renders.
//
// 🔒 PII: public — names follow the leaderboard rules (first_name or an
// anonymous "Collector ####", plus the stable avatar seed; never email/id).
const TOP_N = 10;
// Over-fetch so the disabled filter below cannot shorten the board — same
// reasoning (and the same bound) as the sibling leaderboard route.
const FETCH_N = TOP_N * 2;

/**
 * The running challenge week's view. hiddenAboveCut counts administratively
 * disabled players dropped from the displayed top 10. Settlement still ranks
 * and pays them, so while it is above 0 a displayed rank is not the rank that
 * gets paid. `week` is the anchor the queries used, for challengeWeekBounds.
 */
export async function buildChallengeView(scope: MedusaContainer) {
  const packs: PacksModuleService = scope.resolve(PACKS_MODULE);
  const customerService = scope.resolve(Modules.CUSTOMER);

  const settings = await packs.challengeSettings();
  const week = {
    timezone: settings.timezone,
    resetDay: settings.reset_day,
    resetHour: settings.reset_hour,
  };
  const [pool, rankedAll, stageRows] = await Promise.all([
    // Real community pulled-value this week (ledger aggregate) — the anchor
    // comes from the same settings row the reset line renders.
    packs.challengeWeekPool(week),
    // Weekly Pull Value ranking (pulled value, NOT spend) — the challenge's
    // own top-10, distinct from the spend-ranked main leaderboard.
    packs.challengeWeekTop({ ...week, limit: FETCH_N }),
    packs.listChallengeStages(
      {},
      {
        select: ['stage_number', 'threshold_myr', 'rank_rewards'],
        take: 1000,
      },
    ),
  ]);

  const stages = stageRows
    .map((r) => {
      const table = ((r.rank_rewards as unknown as ChallengeRankReward[]) ?? [])
        .slice()
        .sort((a, b) => a.rank - b.rank);
      return {
        stageNumber: r.stage_number,
        thresholdMyr: Number(r.threshold_myr),
        rankRewards: table.map((x) => ({
          rank: x.rank,
          cardId: x.card_id ?? null,
          credits: Number(x.credits),
        })),
      };
    })
    .sort((a, b) => a.stageNumber - b.stageNumber);

  // Resolve every referenced card id to a thumbnail in ONE query so the
  // storefront renders featured-card art without a round-trip per id.
  // image = slab_image ?? image (graded composite preferred).
  const cardIds = [
    ...new Set(
      stages.flatMap((s) =>
        s.rankRewards
          .map((r) => r.cardId)
          .filter((id): id is string => Boolean(id)),
      ),
    ),
  ];
  // slab_image is carried SEPARATELY from image so the storefront knows when
  // the art is a real graded slab (frameable, wears the prism frame) vs raw
  // card art (not). `handle` is the card's public route key — it is what lets a
  // prize thumbnail link to /card/<handle>, the same "View Details" affordance
  // the pack pool tiles have.
  const cards: Record<
    string,
    {
      name: string;
      handle: string;
      image: string;
      slab_image: string | null;
    }
  > = {};
  if (cardIds.length > 0) {
    const rows = await packs.listCards(
      { id: cardIds },
      {
        select: ['id', 'name', 'handle', 'image', 'slab_image'],
        take: cardIds.length,
      },
    );
    for (const c of rows) {
      cards[c.id] = {
        name: c.name,
        handle: c.handle,
        image: c.slab_image ?? c.image,
        slab_image: c.slab_image ?? null,
      };
    }
  }

  // An administratively disabled player is hidden from every public surface —
  // see the sibling leaderboard route for why this is display-only (a disable
  // is reversible, so settlement still ranks and pays them) and why the
  // survivors are re-numbered without gaps.
  const disabledIds = await packs.disabledCustomerIds(
    rankedAll.map((r) => r.customer_id),
  );
  const ranked: typeof rankedAll = [];
  let hiddenAboveCut = 0;
  for (const r of rankedAll) {
    if (ranked.length === TOP_N) break;
    if (disabledIds.has(r.customer_id)) hiddenAboveCut++;
    else ranked.push(r);
  }

  // PII-safe display fields for the ranked customers (shared with the store
  // leaderboard — never leaks email/id).
  const ids = ranked.map((r) => r.customer_id);
  const customers = ids.length
    ? await customerService.listCustomers({ id: ids }, { take: ids.length })
    : [];
  const byId = new Map(customers.map((c) => [c.id, c]));
  const top = ranked.map((r, i) => {
    const seed = seedOf(r.customer_id);
    const p = publicProfileFields(byId.get(r.customer_id), seed);
    return {
      rank: i + 1,
      name: p.name,
      handle: p.handle,
      volumeMyr: r.volumeMyr,
      pulls: r.pulls,
      seed,
      avatar_url: p.avatarUrl,
    };
  });

  const body = {
    active: stages.length > 0,
    progress: { pooledMyr: pool },
    settings: {
      timezone: settings.timezone,
      resetDay: settings.reset_day,
      resetHour: settings.reset_hour,
    },
    stages,
    cards,
    top,
  };
  return { body, hiddenAboveCut, week };
}

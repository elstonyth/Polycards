import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { Modules } from '@medusajs/framework/utils';
import PacksModuleService from '../../../modules/packs/service';
import { PACKS_MODULE } from '../../../modules/packs';
import { publicProfileFields, seedOf } from '../../../utils/profile-handle';
import type { ChallengeRankReward } from '../../../modules/packs/challenge-validate';

// GET /store/challenge — public read of the Weekly Pulled Value Challenge.
// Plain publishable-key store route, read-only, mirrors GET /store/leaderboard.
//
// Standard ("Weekly Pulled Value Challenge"): every eligible pack draw feeds
// BOTH the community pool and the personal Weekly Pull Value ranking; community
// milestones unlock CUMULATIVE reward stages, each carrying its own per-rank
// prize table (ranks 1-10, card and/or credits); the week's top-10 receive
// everything unlocked. There is NO
// separate flat payout — stages ARE the prize pool (the old settings payout
// fields are retired and not exposed here).
//
// 🔒 PII: public — names follow the leaderboard rules (first_name or an
// anonymous "Collector ####", plus the stable avatar seed; never email/id).
const TOP_N = 10;

// ponytail: per-process 30s cache — this route runs TWO whole-`pull`-table
// aggregates (community pool + top-N pull value) whose cost grows with pull
// history, on a public unauthenticated route. Same TTL as the sibling
// leaderboard board (so /task and the weekly board converge within one
// window); upgrade to Redis if we ever run >1 instance. No query params → one
// entry.
const CACHE_TTL_MS = 30_000;
let challengeCache: { expires: number; body: unknown } | null = null;

/** Test seam: module state outlives a test's fixtures — the http suite runs in
 *  one process, so test A's cached challenge would be served to test B. */
export function clearChallengeCache(): void {
  challengeCache = null;
}

export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  if (challengeCache && challengeCache.expires > Date.now()) {
    res.json(challengeCache.body);
    return;
  }

  const packs: PacksModuleService = req.scope.resolve(PACKS_MODULE);
  const customerService = req.scope.resolve(Modules.CUSTOMER);

  const settings = await packs.challengeSettings();
  const week = {
    timezone: settings.timezone,
    resetDay: settings.reset_day,
    resetHour: settings.reset_hour,
  };
  const [pool, ranked, stageRows] = await Promise.all([
    // Real community pulled-value this week (ledger aggregate) — the anchor
    // comes from the same settings row the reset line renders.
    packs.challengeWeekPool(week),
    // Weekly Pull Value ranking (pulled value, NOT spend) — the challenge's
    // own top-10, distinct from the spend-ranked main leaderboard.
    packs.challengeWeekTop({ ...week, limit: TOP_N }),
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
        // Legacy projection — the shipped storefront reads these until the
        // per-rank UI lands (plan 057 phase 2): podium = ranks 1-3 cards,
        // rewardCredits = the largest credits configured for ranks 4-10.
        rewardCardIds: table
          .filter((x) => x.rank <= 3 && x.card_id)
          .map((x) => x.card_id as string),
        rewardCredits: Math.max(
          0,
          ...table.filter((x) => x.rank >= 4).map((x) => Number(x.credits)),
        ),
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
  const cards: Record<string, { name: string; image: string }> = {};
  if (cardIds.length > 0) {
    const rows = await packs.listCards(
      { id: cardIds },
      { select: ['id', 'name', 'image', 'slab_image'], take: cardIds.length },
    );
    for (const c of rows) {
      cards[c.id] = { name: c.name, image: c.slab_image ?? c.image };
    }
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
  challengeCache = { expires: Date.now() + CACHE_TTL_MS, body };
  res.json(body);
}

import type { AuthenticatedMedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../modules/packs';
import type PacksModuleService from '../../../modules/packs/service';
import {
  unlockedKeys,
  levelForXp,
  ACHIEVEMENT_XP_LADDER,
  type AchMetric,
} from '../../../modules/packs/achievements-ladder';

// GET /store/achievements — the logged-in customer's collector level, total XP,
// next level, and the full achievement list with unlocked/progress.
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const customerId = req.auth_context?.actor_id;
  if (!customerId) {
    throw new MedusaError(MedusaError.Types.UNAUTHORIZED, 'Unauthorized');
  }

  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);

  const [summary, defs, grants, stateRow, pulls] = await Promise.all([
    packs.creditSummary(customerId),
    packs.listAchievementDefs(
      {},
      { select: ['key', 'name', 'description', 'category', 'rarity', 'xp', 'metric', 'threshold'], take: 10000 },
    ),
    packs.listAchievementGrants(
      { customer_id: customerId },
      { select: ['achievement_key', 'unlocked_at'], take: 10000 },
    ),
    packs
      .listAchievementMemberStates({ customer_id: customerId }, { take: 1 })
      .then(([row]) => row ?? null),
    packs.listPulls(
      { customer_id: customerId },
      { select: ['source', 'status'], take: 100000 },
    ),
  ]);

  const metrics = {
    spend: summary.externalFundedSpendTotal,
    cases_opened: pulls.filter((p) => p.source === 'pack').length,
    collection_size: pulls.filter((p) => p.status !== 'bought_back').length,
  };
  const unlockedByKey = new Map(grants.map((g) => [g.achievement_key, g]));

  // ponytail: compute earned = grants ∪ liveUnlocked ONCE so per-badge flags and
  // aggregate always derive from the same set (fixes "0/16 unlocked" vs real level).
  const liveUnlocked = new Set(
    unlockedKeys(
      metrics,
      defs.map((d) => ({ key: d.key, metric: d.metric as AchMetric, threshold: Number(d.threshold) })),
    ),
  );
  // Grants are authoritative (monotonic/peak-based); liveUnlocked covers legacy
  // customers with no grant rows yet. For up-to-date customers grants ⊇ liveUnlocked.
  const earned = new Set([...unlockedByKey.keys(), ...liveUnlocked]);

  const achievements = defs
    .map((d) => {
      const threshold = Number(d.threshold);
      const metric = d.metric as AchMetric;
      const current = Math.min(metrics[metric], threshold);
      const g = unlockedByKey.get(d.key);
      return {
        key: d.key,
        name: d.name,
        description: d.description,
        category: d.category,
        rarity: d.rarity,
        xp: Number(d.xp),
        metric,
        unlocked: earned.has(d.key),
        unlocked_at: g ? g.unlocked_at : null,
        progress: { current, target: threshold },
      };
    })
    .sort((a, b) => a.xp - b.xp);

  // Derive total_xp from earned (same set as per-badge flags) so aggregate and
  // badge count are always consistent — never read stateRow.total_xp directly.
  const totalXp = defs
    .filter((d) => earned.has(d.key))
    .reduce((s, d) => s + Number(d.xp), 0);
  const collectorLevel = levelForXp(totalXp);
  const highest = Math.max(collectorLevel, stateRow ? Number(stateRow.highest_level_ever) : collectorLevel);

  const nextRung = ACHIEVEMENT_XP_LADDER.find((r) => r.level === collectorLevel + 1) ?? null;
  const next_level = nextRung
    ? {
        level: nextRung.level,
        xp_threshold: nextRung.xp_threshold,
        remaining: Math.max(0, nextRung.xp_threshold - totalXp),
      }
    : null;

  res.json({
    collector_level: collectorLevel,
    total_xp: totalXp,
    highest_level_ever: highest,
    next_level,
    achievements,
  });
}

import type PacksModuleService from '../../modules/packs/service';
import type { LiveRankTarget } from './automation-live-types';
import type { RankObservation } from './automation-rank';

type Leaderboards = Pick<
  PacksModuleService,
  | 'challengeSettings'
  | 'challengeWeekBounds'
  | 'challengeWeekTop'
  | 'challengeWeekVolumeFor'
  | 'leaderboardTop'
  | 'disabledCustomerIds'
>;

/** Uncached decisions use the public board's aggregates, ordering and visibility filter. */
export async function observeLiveRanks(
  packs: Leaderboards,
  targets: LiveRankTarget[],
  clock = Date.now,
): Promise<RankObservation[]> {
  const observations: RankObservation[] = [];
  for (const period of ['weekly', 'alltime'] as const) {
    const selected = targets.filter((row) => row.period === period);
    if (!selected.length) continue;
    const observedAt = clock();
    try {
      const settings =
        period === 'weekly' ? await packs.challengeSettings() : null;
      const anchor = settings
        ? {
            timezone: settings.timezone,
            resetDay: settings.reset_day,
            resetHour: settings.reset_hour,
          }
        : null;
      const bounds = anchor ? await packs.challengeWeekBounds(anchor) : null;
      const ranked = anchor
        ? (await packs.challengeWeekTop({ ...anchor, limit: 20 })).map(
            (row) => ({
              customerId: row.customer_id,
              pulls: row.pulls,
              valueMyr: row.volumeMyr,
            }),
          )
        : (await packs.leaderboardTop({ sinceMs: null, limit: 20 })).map(
            (row) => ({
              customerId: row.customer_id,
              pulls: row.pulls,
              valueMyr: row.volume,
            }),
          );
      const disabled = await packs.disabledCustomerIds(
        ranked.map((row) => row.customerId),
      );
      const entries = ranked
        .filter((row) => !disabled.has(row.customerId))
        .slice(0, 10);
      const own = anchor
        ? await Promise.all(
            selected.map(async (target) => {
              const score = await packs.challengeWeekVolumeFor({
                ...anchor,
                customerId: target.customerId,
              });
              return {
                customerId: target.customerId,
                pulls: score.pulls,
                valueMyr: score.volumeMyr,
              };
            }),
          )
        : (
            await packs.leaderboardTop({
              sinceMs: null,
              limit: selected.length,
              customerIds: selected.map((row) => row.customerId),
            })
          ).map((row) => ({
            customerId: row.customer_id,
            pulls: row.pulls,
            valueMyr: row.volume,
          }));
      if (
        anchor &&
        bounds &&
        (await packs.challengeWeekBounds(anchor)).startUtc.getTime() !==
          bounds.startUtc.getTime()
      )
        continue;
      for (const target of selected) {
        const score = own.find((row) => row.customerId === target.customerId);
        observations.push({
          periodKey: bounds?.startUtc.toISOString() ?? 'alltime',
          observedAt,
          ...(bounds ? { validUntil: bounds.endUtc.getTime() } : {}),
          customerId: target.customerId,
          ownPulls: score?.pulls ?? 0,
          ownValueMyr: score?.valueMyr ?? 0,
          entries,
        });
      }
    } catch {
      // Missing evidence holds the goal; it must never authorize a paid draw.
    }
  }
  return observations;
}

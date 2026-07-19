/**
 * Weekly Pulled Value Challenge data seam (GET /store/challenge). Mirrors
 * data/leaderboard.ts: a server-side fetch, zod-validated, mapped to a
 * presentational shape. Returns null when the challenge is OFF (active:false /
 * no stages) or the backend is unreachable — the /task page then renders its
 * honest "launching soon" empty state.
 *
 * Standard semantics: stages unlock as the REAL community pool (pull-ledger
 * aggregate) crosses thresholds; rewards are CUMULATIVE and form the top-10
 * prize pool — featured cards for ranks 1-3, credits for ranks 4-10. The
 * weekly top-10 standings are ranked by pulled value (not spend — that's the
 * main leaderboard). Nothing here is invented: pool, states, summary, and
 * standings all derive from ledger data.
 */
import { sdk } from '@/lib/medusa';
import { logger } from '@/lib/logger';
import { rm0, compact } from '@/lib/format';
import { avatarForSeed } from '@/lib/profile-view';
import { parseOne, ChallengeSchema } from '@/lib/data/schemas';

export interface ChallengeCard {
  name: string;
  image: string;
}
export type ChallengeStageState = 'complete' | 'active' | 'locked';
export interface ChallengeStage {
  stageNumber: number;
  /** Formatted MYR unlock threshold, e.g. "RM 100,000". */
  threshold: string;
  /** Short marker label, e.g. "RM 100K". */
  thresholdCompact: string;
  /** Formatted MYR credit reward for ranks 4-10, e.g. "RM 1,000". */
  reward: string;
  /** Featured cards for ranks 1-3. */
  cards: ChallengeCard[];
  /** Derived from the real pool; null when the backend sent no progress. */
  state: ChallengeStageState | null;
  /** Marker position along the pool bar (threshold / top threshold, 0-100). */
  pct: number;
  /** Pool progress toward THIS stage's threshold, 0-100 (100 once unlocked);
   *  null when the backend sent no progress. Drives the stage card's mini bar. */
  progressPct: number | null;
}
export interface ChallengePool {
  /** Formatted community pulled-value this week, e.g. "RM 383,292". */
  pooled: string;
  /** Formatted final-stage threshold, e.g. "RM 1,000,000". */
  topThreshold: string;
  /** Pool position vs the top threshold, 0-100 (capped). */
  overallPct: number;
  /** The next stage to unlock; null when every stage is cleared. */
  next: { stageNumber: number; threshold: string; remaining: string } | null;
}
/** Cumulative unlocked rewards — the standard's "Rewards Summary". */
export interface ChallengeSummary {
  unlockedCount: number;
  /** All featured cards from unlocked stages (top-3 prize). */
  cards: ChallengeCard[];
  /** Sum of unlocked stage credits, formatted (ranks 4-10 prize). */
  credits: string;
}
export interface ChallengeTopEntry {
  rank: number;
  name: string;
  handle: string | null;
  /** Formatted pulled value, e.g. "RM 285,012". */
  volume: string;
  avatar: string;
}
export interface Challenge {
  /** e.g. "Resets Mondays 00:00 (MYT)". */
  resetLabel: string;
  stages: ChallengeStage[];
  /** Null when the backend sent no progress (older deploy) — hide the panel. */
  pool: ChallengePool | null;
  /** Null exactly when pool is null (both derive from real progress). */
  summary: ChallengeSummary | null;
  /** Weekly Pull Value top-10; [] when the backend sent none. */
  top: ChallengeTopEntry[];
}

const DAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

// Short timezone tag for the reset line. A tiny known-zone map keeps it honest
// without pulling a tz library; an unknown zone falls back to the raw IANA name.
const TZ_ABBR: Record<string, string> = {
  'Asia/Kuala_Lumpur': 'MYT',
  UTC: 'UTC',
};

/** "Resets Mondays 00:00 (MYT)" from (resetDay 0=Sun…6=Sat, resetHour, timezone). */
export function formatReset(
  day: number,
  hour: number,
  timezone: string,
): string {
  const name = DAYS[((Math.trunc(day) % 7) + 7) % 7] ?? 'Monday';
  const hh = String(Math.max(0, Math.min(23, Math.trunc(hour)))).padStart(
    2,
    '0',
  );
  const tz = TZ_ABBR[timezone] ?? timezone;
  return `Resets ${name}s ${hh}:00 (${tz})`;
}

export async function getChallenge(): Promise<Challenge | null> {
  try {
    const raw = await sdk.client.fetch<unknown>('/store/challenge');
    const data = parseOne(ChallengeSchema, raw);
    if (!data || !data.active || data.stages.length === 0) return null;

    const cardsFor = (ids: string[]): ChallengeCard[] =>
      ids.flatMap((id) => {
        const c = data.cards[id];
        return c ? [{ name: c.name, image: c.image }] : [];
      });

    const ordered = data.stages
      .slice()
      .sort((a, b) => a.stageNumber - b.stageNumber);
    const top = ordered[ordered.length - 1]?.thresholdMyr ?? 0;
    const pooled = data.progress?.pooledMyr ?? null;
    // First stage the pool hasn't reached yet — everything before it is
    // complete, everything after locked. null when all stages are cleared.
    const nextStage =
      pooled === null
        ? null
        : (ordered.find((s) => pooled < s.thresholdMyr) ?? null);
    const unlocked =
      pooled === null ? [] : ordered.filter((s) => pooled >= s.thresholdMyr);

    return {
      resetLabel: formatReset(
        data.settings.resetDay,
        data.settings.resetHour,
        data.settings.timezone,
      ),
      pool:
        pooled === null
          ? null
          : {
              pooled: rm0(pooled),
              topThreshold: rm0(top),
              overallPct: top > 0 ? Math.min(100, (pooled / top) * 100) : 0,
              next: nextStage
                ? {
                    stageNumber: nextStage.stageNumber,
                    threshold: rm0(nextStage.thresholdMyr),
                    remaining: rm0(
                      Math.max(0, nextStage.thresholdMyr - pooled),
                    ),
                  }
                : null,
            },
      summary:
        pooled === null
          ? null
          : {
              unlockedCount: unlocked.length,
              cards: unlocked.flatMap((s) => cardsFor(s.rewardCardIds)),
              credits: rm0(
                unlocked.reduce((sum, s) => sum + s.rewardCredits, 0),
              ),
            },
      stages: ordered.map((s) => ({
        stageNumber: s.stageNumber,
        threshold: rm0(s.thresholdMyr),
        thresholdCompact: `RM ${compact(s.thresholdMyr)}`,
        reward: rm0(s.rewardCredits),
        cards: cardsFor(s.rewardCardIds),
        pct: top > 0 ? Math.min(100, (s.thresholdMyr / top) * 100) : 0,
        progressPct:
          pooled === null
            ? null
            : s.thresholdMyr > 0
              ? Math.min(100, (pooled / s.thresholdMyr) * 100)
              : 100,
        state:
          pooled === null
            ? null
            : pooled >= s.thresholdMyr
              ? 'complete'
              : nextStage && s.stageNumber === nextStage.stageNumber
                ? 'active'
                : 'locked',
      })),
      top: (data.top ?? []).map((t) => ({
        rank: t.rank,
        name: t.name,
        handle: typeof t.handle === 'string' ? t.handle : null,
        volume: rm0(t.volumeMyr),
        avatar: t.avatar_url ?? avatarForSeed(t.seed),
      })),
    };
  } catch (error) {
    logger.error('[challenge] failed to load:', error);
    return null;
  }
}

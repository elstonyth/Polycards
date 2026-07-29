/**
 * Weekly Pulled Value Challenge data seam (GET /store/challenge). Mirrors
 * data/leaderboard.ts: a server-side fetch, zod-validated, mapped to a
 * presentational shape. Returns null when the challenge is OFF (active:false /
 * no stages) or the backend is unreachable — the Ranks page (/leaderboard) then
 * simply omits the challenge block and renders the standings alone.
 *
 * Standard semantics: stages unlock as the REAL community pool (pull-ledger
 * aggregate) crosses thresholds; rewards are CUMULATIVE and form the top-10
 * prize pool — each stage carries its own SPARSE per-rank table (ranks 1-10,
 * a card and/or credits per rank; an absent rank pays nothing). The
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
  /** The graded-slab composite, when the card has one. Only a real slab gets
   *  the prism frame — raw card art has the wrong aspect for the band. */
  slabImage: string | null;
}
/** One configured prize rank (1–10) of a stage. `rank` is carried EXPLICITLY —
 *  never a list index — so an unresolvable card id can never shift a lower rank
 *  under the wrong numeral. A rank may carry a card AND/OR credits; ranks with
 *  neither (nothing configured, or an unresolvable card and no credits) are
 *  omitted from the list entirely rather than rendered empty. */
export interface ChallengeRankReward {
  rank: number;
  /** Resolved prize card; null when this rank pays credits only (or its id
   *  couldn't be resolved — the row survives on its credits). */
  card: ChallengeCard | null;
  /** Raw MYR credit amount for this rank; 0 = card-only rank. */
  credits: number;
  /** Formatted credits, e.g. "RM 1,000"; null when this rank pays no credits. */
  creditsLabel: string | null;
}
export type ChallengeStageState = 'complete' | 'active' | 'locked';
export interface ChallengeStage {
  stageNumber: number;
  /** Formatted MYR unlock threshold, e.g. "RM 100,000". */
  threshold: string;
  /** Short marker label, e.g. "RM 100K". */
  thresholdCompact: string;
  /** Formatted SUM of the credits configured across ranks 4-10 of this stage,
   *  e.g. "RM 1,000" — what the stage hands out below the podium in total, not
   *  a per-winner figure. The ranks 4-10 sheet breaks it down per rank. */
  reward: string;
  /** Every configured rank of this stage (ascending), card and/or credits. */
  rankRewards: ChallengeRankReward[];
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
  /** Every prize card from unlocked stages, deduped by card id. */
  cards: ChallengeCard[];
  /** Formatted sum of EVERY rank's credits across unlocked stages — the total
   *  credit pool unlocked so far, not a per-winner amount. */
  credits: string;
}
/** What a standings rank wins RIGHT NOW — the cumulative prize across every
 *  UNLOCKED stage at that rank (rewards stack stage over stage, same rule as
 *  the summary). EVERY card is listed (operator: no `+N` collapse), highest
 *  unlocked stage's first; credits sum. Empty until a stage unlocks or when
 *  the backend sent no progress — the standings then render without a prize
 *  column. */
export interface ChallengeRankPrize {
  rank: number;
  /** All prize cards across unlocked stages, highest stage first; [] when
   *  this rank currently pays credits only. */
  cards: ChallengeCard[];
  /** Formatted credit sum, e.g. "RM 1,000"; null when no credits. */
  creditsLabel: string | null;
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
  /** Per-rank CURRENT prize table (unlocked stages, cumulative), sparse and
   *  ascending — feeds the weekly standings' prize column. */
  rankPrizes: ChallengeRankPrize[];
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

    // Flat resolver: drop ids the backend couldn't resolve (deleted card).
    // Used for the summary, where order/rank don't matter.
    const resolveCards = (ids: string[]): ChallengeCard[] =>
      ids.flatMap((id) => {
        const c = data.cards[id];
        return c
          ? [{ name: c.name, image: c.image, slabImage: c.slab_image ?? null }]
          : [];
      });
    // Resolver for a stage per-rank prize table. `rank` comes from the row
    // itself, so an unresolvable card id can never shift a lower rank under the
    // wrong numeral (the row keeps its rank and survives on its credits; with
    // no credits it drops out entirely rather than rendering empty).
    const rankRewardsFor = (
      rows: { rank: number; cardId: string | null; credits: number }[],
    ): ChallengeRankReward[] =>
      rows
        .slice()
        .sort((a, b) => a.rank - b.rank)
        .flatMap((r) => {
          const c = r.cardId ? data.cards[r.cardId] : undefined;
          const credits = Math.max(0, r.credits);
          if (!c && credits === 0) return [];
          return [
            {
              rank: r.rank,
              // slabImage drives the prism frame: only a real graded slab is
              // framed, raw card art has the wrong aspect for the band.
              card: c
                ? {
                    name: c.name,
                    image: c.image,
                    slabImage: c.slab_image ?? null,
                  }
                : null,
              credits,
              creditsLabel: credits > 0 ? rm0(credits) : null,
            },
          ];
        });
    const creditsOf = (
      rows: { rank: number; credits: number }[],
      minRank = 1,
    ): number =>
      rows.reduce(
        (sum, r) => (r.rank >= minRank ? sum + Math.max(0, r.credits) : sum),
        0,
      );

    // `rankRewards` is optional (deploy skew) — normalize once so every
    // consumer below reads a plain array.
    const ordered = data.stages
      .slice()
      .sort((a, b) => a.stageNumber - b.stageNumber)
      .map((s) => ({ ...s, rankRewards: s.rankRewards ?? [] }));
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

    // What each rank wins right now: rewards are cumulative, so a rank's prize
    // is every unlocked stage's row at that rank. `unlocked` is ascending;
    // cards list highest-stage-first (the headline leads) — ALL of them, the
    // operator rejected the +N collapse — and credits sum across stages.
    const rankPrizes: ChallengeRankPrize[] = Array.from(
      { length: 10 },
      (_, i) => i + 1,
    ).flatMap((rank) => {
      const rows = unlocked.flatMap((s) =>
        s.rankRewards.filter((r) => r.rank === rank),
      );
      const cards = rows.flatMap((r) => {
        const c = r.cardId ? data.cards[r.cardId] : undefined;
        return c ? [c] : [];
      });
      const credits = rows.reduce((sum, r) => sum + Math.max(0, r.credits), 0);
      if (cards.length === 0 && credits === 0) return [];
      return [
        {
          rank,
          cards: cards
            .map((c) => ({
              name: c.name,
              image: c.image,
              slabImage: c.slab_image ?? null,
            }))
            .reverse(),
          creditsLabel: credits > 0 ? rm0(credits) : null,
        },
      ];
    });

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
              // Dedupe by card IDENTITY (id), not image: the same card featured
              // in two unlocked stages shows one thumb, while two distinct cards
              // that happen to share fallback art are NOT collapsed. Dedupe the
              // ids first, then resolve.
              cards: resolveCards([
                ...new Set(
                  unlocked.flatMap((s) =>
                    s.rankRewards
                      .map((r) => r.cardId)
                      .filter((id): id is string => Boolean(id)),
                  ),
                ),
              ]),
              // Ranks 4-10 only, matching the stage tile (reward, below) and the
              // "Total credits across ranks 4-10" summary label. Podium credits
              // have no display surface (see StageCarousel), so counting them
              // here would inflate a figure the operator can't see itemised.
              credits: rm0(
                unlocked.reduce(
                  (sum, s) => sum + creditsOf(s.rankRewards, 4),
                  0,
                ),
              ),
            },
      stages: ordered.map((s) => ({
        stageNumber: s.stageNumber,
        threshold: rm0(s.thresholdMyr),
        thresholdCompact: `RM ${compact(s.thresholdMyr)}`,
        reward: rm0(creditsOf(s.rankRewards, 4)),
        rankRewards: rankRewardsFor(s.rankRewards),
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
      rankPrizes,
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

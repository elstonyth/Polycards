/**
 * View-model the profile page renders, mapped from the public profile
 * (`/store/profiles/:handle`) so `ProfileClient` stays purely presentational.
 *
 * It used to serve a second source too — a deterministic mock pool for unknown
 * handles — which is why the shape is source-agnostic. That fallback is gone:
 * an unknown name is a 404, not an invented collector.
 */
import type { PublicProfile } from '@/lib/data/profiles';
import { relativeTime } from '@/lib/format';
import { toCardView, type CardView } from '@/lib/card-view';
import type { LeaderboardEntry } from '@/lib/data/leaderboard';

/** A profile card: the card view (its `priceMyr` is null when the backend
 *  hasn't enriched marketPriceMyr — ProfileClient shows '—', never the raw USD
 *  market_value behind an "RM" prefix; its `rarity` is null on an older
 *  backend, so the slab renders frameless rather than in a guessed tier) plus
 *  the grading line the showcase prints. */
export type ProfileViewCard = CardView & { grader: string; grade: string };

export interface ProfileViewActivity {
  verb: string;
  time: string;
  card: ProfileViewCard;
}

export interface ProfileViewUser {
  username: string;
  pfp: string;
  frame: string | null;
  /** Milestone level behind `frame` — drives the animated frame shader. */
  frameLevel: number | null;
  /** Position on the WEEKLY board (the Ranks tab's top 10) — null (rendered
   *  "—") when off it. Read from the board itself, never recomputed, so the
   *  profile and /leaderboard can't show two different ranks. */
  rank: number | null;
  /** All-time figures — equal to the All Time board row, not the weekly board. */
  pulls: number;
  volume: number;
  joined: string;
  collection: ProfileViewCard[];
  /** Real pull activity (verb + relative time); absent → mock-style derived. */
  activity?: ProfileViewActivity[];
}

const PFP_COUNT = 81; // public/images/pfps/pfp-1..81.webp

/** Seed → avatar path — shared with the leaderboard seam so the same seed
 * always renders the same avatar on both surfaces. A non-finite seed (a dropped/
 * renamed backend field) falls back to a fixed avatar instead of pfp-NaN.webp. */
export const avatarForSeed = (seed: number): string => {
  const n = Number.isFinite(seed) ? Math.abs(Math.trunc(seed)) : 0;
  return `/images/pfps/pfp-${(n % PFP_COUNT) + 1}.webp`;
};

/** Join year for "Collecting since {year}" — "—" for an unparsable date. */
function joinedYear(iso: string): string {
  const year = new Date(iso).getFullYear();
  return Number.isFinite(year) ? String(year) : '—';
}

/** Real backend profile → the view the page renders. */
export function toProfileView(
  profile: PublicProfile,
  avatarFrames: Record<string, string> = {},
  weeklyBoard: Pick<LeaderboardEntry, 'rank' | 'seed'>[] = [],
): ProfileViewUser {
  // Collection = showcased cards (opt-in). Activity = all recent pulls.
  const collectionCards: ProfileViewCard[] = (profile.collection ?? []).map(
    (c) => ({ ...toCardView(c), grader: c.grader, grade: c.grade }),
  );

  // Guard `recent` by SHAPE (not just nullishness): the schema is intentionally
  // loose, so a regressed field could be absent OR a non-array (object/string),
  // either of which would crash the `.map()`s below. Array.isArray handles both.
  // Both .map()s read this SAME array so their indices stay aligned.
  const recent = Array.isArray(profile.recent) ? profile.recent : [];
  const activityCards: ProfileViewCard[] = recent.map((p) => ({
    ...toCardView(p.card),
    grader: p.card.grader,
    grade: p.card.grade,
  }));

  return {
    username: profile.name,
    pfp: profile.avatar_url ?? avatarForSeed(profile.seed),
    frame: profile.equipped_frame_level
      ? (avatarFrames[String(profile.equipped_frame_level)] ?? null)
      : null,
    frameLevel:
      profile.equipped_frame_level &&
      avatarFrames[String(profile.equipped_frame_level)]
        ? profile.equipped_frame_level
        : null,
    // Matched by seed (seedOf(customer_id) on both routes) — the same key the
    // board's own "YOU" row uses; the handle can go stale on a rename.
    rank: weeklyBoard.find((e) => e.seed === profile.seed)?.rank ?? null,
    pulls: profile.stats.pulls,
    volume: profile.stats.volume,
    joined: joinedYear(profile.joined_at),
    collection: collectionCards,
    activity: recent.map((p, i) => ({
      verb: 'pulled',
      time: relativeTime(p.rolled_at),
      // activityCards is built from the same `recent` array — same length,
      // so index i is always in bounds
      card: activityCards[i]!,
    })),
  };
}

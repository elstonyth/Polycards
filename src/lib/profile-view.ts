/**
 * View-model the profile page renders — one shape for BOTH sources: the real
 * public profile (`/store/profiles/:handle`) and the deterministic mock pool
 * (unknown handles / backend down), so `ProfileClient` stays purely
 * presentational and pixel-identical across the two.
 */
import type { MockUser } from '@/lib/mock/users';
import type { PublicProfile } from '@/lib/data/profiles';
import { relativeTime } from '@/lib/format';

export interface ProfileViewCard {
  id: string;
  name: string;
  image: string;
  grader: string;
  grade: string;
  price: number;
}

export interface ProfileViewActivity {
  verb: string;
  time: string;
  card: ProfileViewCard;
}

export interface ProfileViewUser {
  username: string;
  pfp: string;
  /** Global rank is a leaderboard concern — null (rendered "—") for real profiles. */
  rank: number | null;
  points: number;
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
export function toProfileView(profile: PublicProfile): ProfileViewUser {
  // Collection = showcased cards (opt-in). Activity = all recent pulls.
  const collectionCards: ProfileViewCard[] = (profile.collection ?? []).map(
    (c) => ({
      id: c.handle,
      name: c.name,
      image: c.image,
      grader: c.grader,
      grade: c.grade,
      // Live MYR display value; raw USD FMV only as an old-backend fallback.
      price: c.marketPriceMyr ?? c.market_value,
    }),
  );

  // Guard `recent` by SHAPE (not just nullishness): the schema is intentionally
  // loose, so a regressed field could be absent OR a non-array (object/string),
  // either of which would crash the `.map()`s below. Array.isArray handles both.
  // Both .map()s read this SAME array so their indices stay aligned.
  const recent = Array.isArray(profile.recent) ? profile.recent : [];
  const activityCards: ProfileViewCard[] = recent.map((p) => ({
    id: p.card.handle,
    name: p.card.name,
    image: p.card.image,
    grader: p.card.grader,
    grade: p.card.grade,
    price: p.card.marketPriceMyr ?? p.card.market_value,
  }));

  return {
    username: profile.name,
    pfp: avatarForSeed(profile.seed),
    rank: null,
    points: profile.stats.points,
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

/** Mock-pool user → the same view (fallback/skeleton path). */
export function mockProfileView(user: MockUser): ProfileViewUser {
  return {
    username: user.username,
    pfp: user.pfp,
    rank: user.rank,
    points: user.points,
    pulls: user.pulls,
    volume: user.volume,
    joined: user.joined,
    collection: user.collection,
  };
}

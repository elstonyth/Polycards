// Pure leaf (no imports) so the zod schemas and client components can map a
// face seed without pulling in profile-view's card-view/zod chain.
const PFP_COUNT = 81; // public/images/pfps/pfp-1..81.webp

/** Seed → avatar path — shared with the leaderboard seam so the same seed
 * always renders the same avatar on both surfaces. A non-finite seed (a dropped/
 * renamed backend field) falls back to a fixed avatar instead of pfp-NaN.webp. */
export const avatarForSeed = (seed: number): string => {
  const n = Number.isFinite(seed) ? Math.abs(Math.trunc(seed)) : 0;
  return `/images/pfps/pfp-${(n % PFP_COUNT) + 1}.webp`;
};

// Pure leaf (no imports) so the zod schemas and client components can map a
// face seed without pulling in profile-view's card-view/zod chain.

// The backend's preset route (store/profile/avatar/preset) keeps its own copy
// of this count and path: it builds the URL it stores from a validated id.
export const AVATAR_COUNT = 80; // public/images/avatars/avatar-1..80.webp

// shortcut: public/images/pfps (the old 81) stays, unreferenced, so a tab open
// across a deploy and any stored old path still load. Delete it once a prod count
// finds no stored /images/pfps/ value.

/** Catalog id (1..AVATAR_COUNT) → avatar path. */
export const avatarPath = (id: number): string =>
  `/images/avatars/avatar-${id}.webp`;

/** A catalog avatar, as opposed to a photo the customer uploaded. */
export const isCatalogAvatar = (url: string): boolean =>
  url.startsWith('/images/avatars/');

/** Seed → avatar path — shared with the leaderboard seam so the same seed
 * always renders the same avatar on both surfaces. This is how a customer with
 * no stored avatar gets their assigned one: nothing is written per customer. A
 * non-finite seed (a dropped/renamed backend field) falls back to a fixed avatar
 * instead of avatar-NaN.webp. */
export const avatarForSeed = (seed: number): string => {
  const n = Number.isFinite(seed) ? Math.abs(Math.trunc(seed)) : 0;
  return avatarPath((n % AVATAR_COUNT) + 1);
};

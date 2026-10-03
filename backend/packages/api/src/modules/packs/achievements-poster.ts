import {
  composeLadderPoster,
  LADDER_MAX_TILES,
  type LadderPoster,
  renderLadderPoster,
} from './ladder-poster';

export { ladderSlots } from './ladder-poster';

// The VIP-level achievements ladder as a post graphic for the Growth desk bot
// (GET /reports/growth/achievements-poster), drawn by the ladder poster: the
// crown the /task Achievements tab uses, "Level up. Unlock real rewards.",
// then one tile per level with the prize's official picture, its name as
// /task words it and what /task says it is worth, in chase gold. Every word
// on it is fixed or comes from live data; the bot types nothing.

export type AchievementTile = {
  level: number;
  kind: 'credit' | 'pack' | 'card';
  /** As /task words it: 'Free rip · Silver Pack', 'RM 50.00 credit'. */
  prize: string;
  /** What /task says it is worth; a credit's is its own amount, so it gets
   *  no "Worth" line. null = no value to show. */
  valueMyr: number | null;
};

export type AchievementsPosterInput = {
  /** Lowest level first; at most ACHIEVEMENTS_MAX_TILES. */
  tiles: AchievementTile[];
  /** Bare address beside the pill, e.g. 'polycards.gg/task'. */
  siteHost: string;
};

export const ACHIEVEMENTS_MAX_TILES = LADDER_MAX_TILES;

// Lucide crown, the Achievements tab's icon.
const ICON_CROWN =
  '<path d="M11.562 3.266a.5.5 0 0 1 .876 0L15.39 8.87a1 1 0 0 0 1.516.294L21.183 5.5a.5.5 0 0 1 .798.519l-2.834 10.246a1 1 0 0 1-.956.734H5.81a1 1 0 0 1-.957-.734L2.02 6.02a.5.5 0 0 1 .798-.519l4.276 3.664a1 1 0 0 0 1.516-.294z"/>' +
  '<path d="M5 21h14"/>';

const poster = (input: AchievementsPosterInput): LadderPoster => ({
  eyebrow: 'ACHIEVEMENTS',
  eyebrowIcon: ICON_CROWN,
  headline: ['Level up.', 'Unlock real rewards.'],
  tiles: input.tiles.map((t) => ({
    label: `LV.${t.level}`,
    note: null,
    key: t.level,
    kind: t.kind,
    title: t.prize,
    valueMyr: t.valueMyr,
  })),
  valueLabel: 'Worth',
  siteHost: input.siteHost,
});

/** Compose the poster. `art[i]` is the picture of `input.tiles[i]` (null for
 *  a credit, or when it could not be fetched). `placeholders` lists the
 *  levels of prizes whose picture was missing or did not decode. */
export const composeAchievementsPoster = (
  input: AchievementsPosterInput,
  art: (Buffer | null)[],
) => composeLadderPoster(poster(input), art);

/** Fetch each prize's official picture, then compose. `missing` names the
 *  levels whose picture could not be fetched or decoded. */
export const renderAchievementsPoster = (
  input: AchievementsPosterInput,
  urls: (string | null)[],
) => renderLadderPoster(poster(input), urls);

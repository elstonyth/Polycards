import {
  composeLadderPoster,
  type LadderPoster,
  renderLadderPoster,
} from './ladder-poster';

// A day's biggest pulls as a posting poster for the Growth desk (GET
// /reports/growth/top-pulls-poster and the 12 a.m. cron drop), drawn by the
// ladder poster: a trophy eyebrow with the date, "Real cards. Real pulls.",
// then one tile per pull with the card's slab, its rank, the player's public
// name (the one the Telegram channel already shows), the card and its pulled
// value in chase gold. Nothing on it is typed in.

export type TopPullTile = {
  rank: number;
  cardName: string;
  /** 'PSA 10'; '' for a raw card. */
  grade: string;
  valueMyr: number;
  /** The public display name, never contact details. */
  player: string;
};

// Lucide trophy.
const ICON_TROPHY =
  '<path d="M10 14.66V17a1 1 0 0 1-1 1 2 2 0 0 0-2 2v2"/>' +
  '<path d="M14 14.66V17a1 1 0 0 0 1 1 2 2 0 0 1 2 2v2"/>' +
  '<path d="M17.916 10H19.5A2.5 2.5 0 0 0 22 7.5V5a1 1 0 0 0-1-1h-3"/>' +
  '<path d="M4 22h16"/>' +
  '<path d="M6 9a6 6 0 0 0 12 0V3a1 1 0 0 0-1-1H7a1 1 0 0 0-1 1z"/>' +
  '<path d="M6.084 10H4.5A2.5 2.5 0 0 1 2 7.5V5a1 1 0 0 1 1-1h3"/>';

export function topPullsPoster(input: {
  /** '3 OCT 2026' */
  dayLabel: string;
  /** Highest value first. */
  pulls: TopPullTile[];
  siteHost: string;
}): LadderPoster {
  return {
    eyebrow: `TOP HITS · ${input.dayLabel}`,
    eyebrowIcon: ICON_TROPHY,
    headline: ['Real cards.', 'Real pulls.'],
    tiles: input.pulls.map((p) => ({
      label: `#${p.rank}`,
      note: p.player,
      key: p.rank,
      kind: 'card' as const,
      title: p.grade ? `${p.cardName} · ${p.grade}` : p.cardName,
      valueMyr: p.valueMyr,
    })),
    valueLabel: null,
    siteHost: input.siteHost,
  };
}

/** `art[i]` is the slab of `input.pulls[i]`; `placeholders` lists the ranks
 *  whose picture was missing or did not decode. */
export const composeTopPullsPoster = (
  input: Parameters<typeof topPullsPoster>[0],
  art: (Buffer | null)[],
) => composeLadderPoster(topPullsPoster(input), art);

export const renderTopPullsPoster = (
  input: Parameters<typeof topPullsPoster>[0],
  urls: (string | null)[],
) => renderLadderPoster(topPullsPoster(input), urls);

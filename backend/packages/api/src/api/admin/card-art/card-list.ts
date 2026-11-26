// The full One Piece card list (every printing code), read from Limitless'
// public card database — the list the clean card art was made against. The
// Card art page compares it with the uploaded art to show what is missing.
// Limitless is another site's HTML: when its layout changes the read finds
// too few cards and the refresh route refuses to replace the stored list.
import { normalizeCardArtCode } from './parse';

export const CARD_LIST_ORIGIN = 'https://onepiece.limitlesstcg.com';

export type CardListEntry = { code: string; name: string };

const ENTITIES: Record<string, string> = {
  amp: '&',
  quot: '"',
  '#39': "'",
  '#039': "'",
  apos: "'",
  lt: '<',
  gt: '>',
};
// One pass, so "&amp;lt;" stays "&lt;" (a chained replace would decode it twice).
const unescape = (s: string) =>
  s.replace(/&(amp|quot|#0?39|apos|lt|gt);/g, (_, e: string) => ENTITIES[e]);

/** The set pages linked from the card database index, in page order. */
export function parseSetSlugs(html: string): string[] {
  const slugs = [
    ...html.matchAll(
      /href="\/cards\/((?:op|eb|prb|st)\d{2}-[a-z0-9-]+|promos)"/g,
    ),
  ].map((m) => m[1]);
  return [...new Set(slugs)];
}

/** Every printing on one set page (list view): "OP01-013?v=1" is OP01-013_p1. */
export function parseSetPage(html: string): CardListEntry[] {
  const out: CardListEntry[] = [];
  const rx =
    /<tr data-hover="[^"]*">\s*<td><a href="\/cards\/([^"]+)">[^<]*<\/a><\/td>\s*<td><a[^>]*>([^<]+)<\/a><\/td>/g;
  for (const m of html.matchAll(rx)) {
    const code = normalizeCardArtCode(m[1].replace(/\?v=(\d+)$/, '_p$1'));
    if (code) out.push({ code, name: unescape(m[2].trim()) });
  }
  return out;
}

/** Promo sub-sets ("prize-cards", "misc-promos", celebration packs…) linked
 *  from the promos page: every lower-case /cards/<slug> that is not a main set. */
export function parsePromoSubsets(html: string, mainSets: string[]): string[] {
  const skip = new Set([...mainSets, 'advanced', 'promos']);
  const slugs = [...html.matchAll(/href="\/cards\/([a-z0-9][a-z0-9-]+)"/g)]
    .map((m) => m[1])
    .filter((s) => !skip.has(s));
  return [...new Set(slugs)];
}

/** Reads the index, the promos page and every set and promo sub-set page
 *  (3 at a time, ~150 pages). A reprint listed in two sets is one printing.
 *  Any page failing fails the read: a partial list would show cards as
 *  missing that are not. */
export async function fetchCardList(
  get: (path: string) => Promise<string>,
): Promise<CardListEntry[]> {
  const main = parseSetSlugs(await get('/cards'));
  const slugs = main.includes('promos')
    ? [...main, ...parsePromoSubsets(await get('/cards/promos'), main)]
    : main;
  const pages: CardListEntry[][] = new Array(slugs.length);
  let next = 0;
  const worker = async () => {
    while (next < slugs.length) {
      const i = next++;
      pages[i] = parseSetPage(await get(`/cards/${slugs[i]}?display=list`));
    }
  };
  await Promise.all(Array.from({ length: 3 }, worker));
  const byCode = new Map<string, CardListEntry>();
  for (const e of pages.flat()) if (!byCode.has(e.code)) byCode.set(e.code, e);
  return [...byCode.values()];
}

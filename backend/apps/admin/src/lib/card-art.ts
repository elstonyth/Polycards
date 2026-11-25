// Clean card art (owner 2026-11-26): one stamp-free image per One Piece card
// printing, keyed by its code — OP05-119 is the base art, OP05-119_p3 its
// third alternate art (the naming of Bandai's card list and our files). The
// backend validates the same code shape (api/admin/card-art/parse.ts).

export type CardArtRow = { code: string; image_url: string };

const BASE = '((?:OP|ST|EB|PRB)\\d{2}-\\d{3}|P-\\d{3})';

/** The printing code a file is named by ("OP05-119_p3.webp", "EB02-006_p2_JP.webp.png"), or null. */
export function artCodeFromFilename(name: string): string | null {
  const m = new RegExp(`^${BASE}(?:_p(\\d{1,2}))?(?![0-9])`, 'i').exec(name);
  return m ? m[1].toUpperCase() + (m[2] ? `_p${Number(m[2])}` : '') : null;
}

/** The base card code inside a PriceCharting title ("Monkey.D.Luffy [SP Gold] OP05-119"), or null. */
export function titleCardCode(title: string): string | null {
  const m = new RegExp(`(?:^|[^A-Z0-9])${BASE}(?![0-9])`, 'i').exec(title);
  return m ? m[1].toUpperCase() : null;
}

/** Which uploaded printing a PriceCharting title means. A plain title is the
 *  base art; a bracketed one ("[Alternate Art]", "[SP]", "[Manga]") is an
 *  alternate art, taken on its own only when the card has exactly one.
 *  PriceCharting's labels don't map to Bandai's _pN numbers, so anything else
 *  is the admin's pick from `choices` (every printing of the card). */
export function pickCardArt(
  title: string,
  family: CardArtRow[],
): { auto: CardArtRow | null; choices: CardArtRow[] } {
  const base = titleCardCode(title);
  const alts = family.filter((r) => r.code.includes('_p'));
  const auto = /\[[^\]]+\]/.test(title)
    ? alts.length === 1
      ? alts[0]
      : null
    : (family.find((r) => r.code === base) ?? null);
  return { auto, choices: family };
}

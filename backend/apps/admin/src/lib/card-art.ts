// Clean card art (owner 2026-11-26): one stamp-free image per One Piece card
// printing, keyed by its code — OP05-119 is the base art, OP05-119_p3 its
// third alternate art (the naming of Bandai's card list and our files). The
// backend validates the same code shape (api/admin/card-art/parse.ts).

export type CardArtRow = { code: string; image_url: string };

const BASE = '((?:OP|ST|EB|PRB)\\d{2}-\\d{3}|P-\\d{3})';

/** The printing code a file is named by ("OP05-119_p3.webp", "EB02-006_p2_JP.webp.png"),
 *  or null. Only the code, an optional `_JP` and the extension may follow it:
 *  "OP05-119 (1).png" or "OP05-119_parallel.png" are refused, not read as OP05-119. */
export function artCodeFromFilename(name: string): string | null {
  const m = new RegExp(`^${BASE}(?:_p(\\d{1,2}))?(?=_JP\\b|\\.|$)`, 'i').exec(
    name,
  );
  return m ? m[1].toUpperCase() + (m[2] ? `_p${Number(m[2])}` : '') : null;
}

/** The base card code inside a PriceCharting title ("Monkey.D.Luffy [SP Gold] OP05-119"), or null. */
export function titleCardCode(title: string): string | null {
  const m = new RegExp(`(?:^|[^A-Z0-9])${BASE}(?![0-9])`, 'i').exec(title);
  return m ? m[1].toUpperCase() : null;
}

// PriceCharting labels that reprint the BASE art (a stamp, an errata, a
// starter-deck reprint): the base clean art is right for them. Measured on the
// 11-26 sweep of every One Piece code (324 distinct labels).
const BASE_ART_LABEL =
  /^(?:(?:super )?pre-?release|errata|reprint|release event|\w+ deck)$/i;

/** Which uploaded printing a PriceCharting listing means. No label, or a
 *  base-art label ("[Pre-Release]", "[Errata]"), is the base art; a plain
 *  "[Alternate Art]" is the card's alternate when it has exactly one. Every
 *  other label (SP, Manga, PRB, prize cards…) doesn't map to Bandai's _pN
 *  numbers, and a Japanese listing is a Japanese card, so those are the
 *  admin's pick from `choices` (every printing of the card). */
export function pickCardArt(
  title: string,
  set: string,
  family: CardArtRow[],
): { auto: CardArtRow | null; choices: CardArtRow[] } {
  const base = titleCardCode(title);
  const labels = [...title.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1].trim());
  const alts = family.filter((r) => r.code.includes('_p'));
  let auto: CardArtRow | null = null;
  if (/\bjapanese\b/i.test(set)) auto = null;
  else if (labels.every((l) => BASE_ART_LABEL.test(l)))
    auto = family.find((r) => r.code === base) ?? null;
  else if (
    labels.length === 1 &&
    /^alternate art$/i.test(labels[0]) &&
    alts.length === 1
  )
    auto = alts[0];
  return { auto, choices: family };
}

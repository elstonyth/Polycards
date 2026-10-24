import { getPixelPokemon, type PixelPokemonRow } from './admin-rest';

// One sprite library, separate decks (pack categories): Pokémon sprites are
// numbered by dex, One Piece by their own `number`. The card's set picks the
// deck so a One Piece card is only ever offered (and auto-linked to) One Piece
// sprites — never a Pokémon whose name happens to hide in the card's name.

export type SpriteFranchise = 'pokemon' | 'one-piece';

export const FRANCHISE_LABEL: Record<SpriteFranchise, string> = {
  pokemon: 'Pokémon',
  'one-piece': 'One Piece',
};

/** The deck a card belongs to, from its set / title ("One Piece Romance Dawn",
 *  "Monkey.D.Luffy OP01-024"). Everything else stays Pokémon (the default). */
export function franchiseFor(
  ...hints: (string | null | undefined)[]
): SpriteFranchise {
  const text = hints.filter(Boolean).join(' ');
  // "One Piece" / "One-Piece", or a booster (OP), starter (ST), extra (EB) or
  // premium (PRB) card code — also when glued to a suffix ("OP05-119_p1").
  return /\bone[\s-]*piece\b|(?:^|[^a-z0-9])(?:OP|ST|EB|PRB)\d{2}-\d{3}(?!\d)/i.test(
    text,
  )
    ? 'one-piece'
    : 'pokemon';
}

/** "#025" (Pokémon dex) / "OP #001" (One Piece number); '' when unnumbered. */
export function entryNumber(
  e: Pick<PixelPokemonRow, 'franchise' | 'dex' | 'number'>,
): string {
  const n = (e.franchise ?? 'pokemon') === 'pokemon' ? e.dex : e.number;
  if (n == null) return '';
  const padded = String(n).padStart(3, '0');
  return e.franchise === 'one-piece' ? `OP #${padded}` : `#${padded}`;
}

// Card titles spell some characters differently from the library (the wiki's
// names): TCG prints "Kaido", "Trafalgar Law", "Kouzuki Oden", epithets…
const ALIASES: Record<string, string[]> = {
  Kaidou: ['Kaido'],
  'Trafalgar D. Water Law': ['Trafalgar Law'],
  'Eustass Kid': ['Eustass Captain Kid'],
  'Kozuki Oden': ['Kouzuki Oden'],
  'Kozuki Momonosuke': ['Kouzuki Momonosuke'],
  'Kozuki Hiyori': ['Kouzuki Hiyori'],
  Bentham: ['Bon Kurei', 'Bon Clay'],
  Sakazuki: ['Akainu'],
  Kuzan: ['Aokiji'],
  Borsalino: ['Kizaru'],
  Issho: ['Fujitora'],
  Aramaki: ['Ryokugyu'],
  'Edward Newgate': ['Whitebeard'],
  'Marshall D. Teach': ['Blackbeard'],
  'Charlotte Linlin': ['Big Mom'],
  Enel: ['Eneru'],
  'Nefertari Vivi': ['Nefeltari Vivi'],
};

/** The library name a One Piece search means: "Big Mom" → "Charlotte Linlin",
 *  "trafalgar law" → "Trafalgar D. Water Law" (a TCG spelling or the start of
 *  one, 3+ letters). Anything else searches as typed. */
export function onePieceSearchTerm(q: string): string {
  const typed = q.trim().toLowerCase();
  if (typed.length < 3) return q;
  for (const [name, aliases] of Object.entries(ALIASES)) {
    if (aliases.some((a) => a.toLowerCase().startsWith(typed))) return name;
  }
  return q;
}

const tokens = (s: string) =>
  s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/** True when `needle`'s words appear consecutively in `hay` ("Monkey D. Luffy"
 *  in "Monkey.D.Luffy OP05-119") — word-bounded, so "King" never hits "Kingdew". */
function containsWords(hay: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > hay.length) return false;
  for (let i = 0; i + needle.length <= hay.length; i++) {
    if (needle.every((w, j) => hay[i + j] === w)) return true;
  }
  return false;
}

/** Auto-link a One Piece card to its character's sprite. The longest matching
 *  base name wins ("Monkey D. Luffy" over a bare "Luffy"); two characters tied
 *  for it ("Luffy & Ace") is no match. A variant of that character whose label
 *  is in the title ("[Gear 5]" → gear-5, "(Wano)" → wano) beats the base.
 *  Null = no confident match; the operator links by hand. */
export function matchOnePieceEntry(
  cardName: string,
  rows: PixelPokemonRow[],
): PixelPokemonRow | null {
  const hay = tokens(cardName);
  let best: { row: PixelPokemonRow; len: number; tie: boolean } | null = null;
  for (const row of rows) {
    if (row.franchise !== 'one-piece' || row.variant !== 'normal') continue;
    for (const name of [row.name, ...(ALIASES[row.name] ?? [])]) {
      const needle = tokens(name);
      if (!containsWords(hay, needle)) continue;
      if (!best || needle.length > best.len) {
        best = { row, len: needle.length, tie: false };
      } else if (needle.length === best.len && row.id !== best.row.id) {
        best.tie = true;
      }
    }
  }
  if (!best || best.tie) return null;
  const base = best.row;
  let variant: { row: PixelPokemonRow; len: number } | null = null;
  for (const row of rows) {
    if (
      row.franchise !== 'one-piece' ||
      row.number !== base.number ||
      row.variant === 'normal'
    )
      continue;
    const label = tokens(row.variant);
    if (
      label.length > 0 &&
      label.every((w) => hay.includes(w)) &&
      (!variant || label.length > variant.len)
    ) {
      variant = { row, len: label.length };
    }
  }
  return variant?.row ?? base;
}

/** The sprite picker's deck: the operator's pick while it was made for THIS
 *  card (`hint` = its set + name), else the card's own deck. Switching the
 *  register modal to another product drops a stale pick. */
export function pickerDeck(
  chosen: { deck: SpriteFranchise; hint: string } | null,
  hint: string,
  derived: SpriteFranchise,
): SpriteFranchise {
  return chosen && chosen.hint === hint ? chosen.deck : derived;
}

/** The auto-link attempt key, or null when the picker must not auto-link:
 *  nothing to match, already linked, the operator took over the deck, or they
 *  cleared the link for this name. */
export function autoLinkKey(o: {
  name: string | null | undefined;
  linked: boolean;
  manualDeck: boolean;
  clearedFor: string | null;
  deck: SpriteFranchise;
}): string | null {
  if (!o.name || o.linked || o.manualDeck || o.clearedFor === o.name)
    return null;
  return `${o.deck}:${o.name}`;
}

// The whole One Piece roster is small (126 rows incl. variants): one memoised
// fetch serves every picker on the bulk import page. Kept for a minute, and an
// empty or failed answer not at all, so a roster uploaded while a tab is open
// shows up.
// shortcut: one page of 200 (the route's cap); page through it if the roster
// ever outgrows that.
const ROSTER_TTL_MS = 60_000;
let roster: { at: number; rows: Promise<PixelPokemonRow[]> } | null = null;

export const fetchOnePieceRoster = (): Promise<PixelPokemonRow[]> => {
  if (!roster || Date.now() - roster.at > ROSTER_TTL_MS) {
    const rows = getPixelPokemon({ franchise: 'one-piece', limit: 200 }).then(
      (page) => page.pixel_pokemon,
    );
    const entry = { at: Date.now(), rows };
    roster = entry;
    rows.then(
      (r) => {
        if (r.length === 0 && roster === entry) roster = null;
      },
      () => {
        if (roster === entry) roster = null;
      },
    );
  }
  return roster.rows;
};

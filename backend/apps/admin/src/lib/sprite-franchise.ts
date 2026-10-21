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
  return /one\s*piece|\bOP\d{2}-\d{3}\b|\bST\d{2}-\d{3}\b/i.test(text)
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
};

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

/** Auto-link a One Piece card to its character's BASE sprite (variants are the
 *  operator's pick — a Gear 5 card is still titled "Monkey.D.Luffy"). The
 *  longest matching name wins ("Monkey D. Luffy" over a bare "Luffy").
 *  Null = no confident match; the operator links by hand. */
export function matchOnePieceEntry(
  cardName: string,
  rows: PixelPokemonRow[],
): PixelPokemonRow | null {
  const hay = tokens(cardName);
  let best: { row: PixelPokemonRow; len: number } | null = null;
  for (const row of rows) {
    if (row.franchise !== 'one-piece' || row.variant !== 'normal') continue;
    for (const name of [row.name, ...(ALIASES[row.name] ?? [])]) {
      const needle = tokens(name);
      if (containsWords(hay, needle) && (!best || needle.length > best.len)) {
        best = { row, len: needle.length };
      }
    }
  }
  return best?.row ?? null;
}

// The whole One Piece base roster is small (~100 rows): one memoised fetch
// serves every picker on the bulk import page.
let onePieceBase: Promise<PixelPokemonRow[]> | null = null;

export const fetchOnePieceBase = (): Promise<PixelPokemonRow[]> => {
  if (!onePieceBase) {
    onePieceBase = getPixelPokemon({
      franchise: 'one-piece',
      variant: 'normal',
      limit: 200,
    }).then((page) => page.pixel_pokemon);
    // A failed fetch must not poison the memo — a later mount retries.
    onePieceBase.catch(() => (onePieceBase = null));
  }
  return onePieceBase;
};

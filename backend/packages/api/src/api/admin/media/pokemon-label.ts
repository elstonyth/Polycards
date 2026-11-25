// Pokémon slab label wording, derived from the PriceCharting product name +
// console-name the way PSA prints it. Pure — no I/O. Learnt 2026-11-25 from
// PSA's own records for our 567 graded cards: the newest certificate per
// wording pattern (220 certs, read on psacard.com/cert) plus each set's PSA
// card list. The per-set table lives in pokemon-label-data.ts.
//
//   2025 POKEMON SV11B JP           #169
//   ZEKROM ex                     GEM MT
//   SPECIAL ART RARE                  10
//
// line 1  year + PSA's short set line, read off a real label photo per set
// line 2  the name, uppercased; "ex" stays lower case on Scarlet & Violet and
//         Mega era cards, "EX" upper on the older ones; full arts of the Sun &
//         Moon / Sword & Shield era print "FA/" before the name
// line 3  the variety: the rarity on modern sets ("ART RARE"), the set name on
//         older ones ("VMAX CLIMAX"), set by card-number range
// #       zero-padded to 3 digits on Japanese sets ("#005")
//
// PSA types some names by hand ("PONCHO-WEAR.PIKACHU"); those certificates sit
// in POKEMON_EXACT. A set missing from the table keeps the plain fallback in
// label.ts rather than invented wording.
import { formatCardName } from './label';
import {
  POKEMON_EXACT,
  POKEMON_SETS,
  type PokemonSet,
} from './pokemon-label-data';

export type PokemonLabel = {
  setLine: string; // "POKEMON SV11B JP" (year joins it in labelLines)
  year: string;
  name: string;
  number: string; // "#169"
  variety: string;
};

// Bracket text PriceCharting adds that PSA prints as the variety. Others
// ("[1st Edition]", "[Gold Star]") are already in the set's range wording.
const BRACKET_VARIETY: Record<string, string> = {
  'master ball': 'MASTER BALL REVERSE HOLO', // certs 142352792, 152811914
};

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

export function pokemonSetKey(pcSet: string, suffix?: string): string {
  return norm(pcSet) + (suffix ? `|${suffix.toUpperCase()}` : '');
}

// "Espeon [Master Ball] #62", "Poncho-Wearing Eevee #140/SM-P"
const NAME_RE = /^(.*?)\s*#\s*([A-Za-z0-9-]+?)(?:\/([A-Za-z]+(?:-[A-Za-z]+)?))?\s*$/;

function psaName(title: string, set: PokemonSet): string {
  const bare = title.replace(/\[[^\]]*\]/g, ' ').trim();
  const name = formatCardName(bare)
    .split(' ')
    .map((t) => (/^ex$/i.test(t) ? (set.exLower ? 'ex' : 'EX') : t))
    .join(' ');
  // PSA keeps the name line to 21 characters: "TEAM ROCKET'S MOLTRES ex" prints
  // "ROCKET'S MOLTRES ex" (certs 170249265, 120729024); "TEAM ROCKET'S
  // DUGTRIO" (21) stays whole (cert 153354289).
  return name.length > 21 ? name.replace(/^TEAM ROCKET'S /, "ROCKET'S ") : name;
}

export function pokemonLabel(f: {
  set: string;
  name: string;
}): PokemonLabel | null {
  const m = f.name.trim().match(NAME_RE);
  if (!m) return null;
  const [, title, num, suffix] = m;
  const key = pokemonSetKey(f.set, suffix);
  const set = POKEMON_SETS[key];
  if (!set) return null;
  const digits = /^\d+$/.test(num);
  if (!digits && set.digitsOnly) return null;
  const n = digits ? Number(num) : NaN;
  const number = digits && set.pad ? String(n).padStart(set.pad, '0') : num;
  const range = digits
    ? set.ranges?.find(([from, to]) => n >= from && n <= to)
    : undefined;
  const bracket = title.match(/\[([^\]]+)\]/)?.[1];
  const variety =
    (bracket && BRACKET_VARIETY[norm(bracket)]) ??
    (range ? range[2] : (set.variety ?? ''));
  // PSA drops "FA/" when the variety already says it ("TAG BOLT-FA", cert 179275869).
  const fa =
    (range ? range[3]?.fa : set.fa) &&
    !/(^|[-\s])FA([-\s]|$)|FULL ART/.test(variety);
  const exact = POKEMON_EXACT[`${key}|${number}`];
  return {
    setLine: set.line,
    year: exact?.[2] ?? range?.[3]?.year ?? set.year,
    name: exact?.[0] ?? (fa ? 'FA/' : '') + psaName(title, set),
    number: `#${number}`,
    variety: exact?.[1] ?? variety,
  };
}

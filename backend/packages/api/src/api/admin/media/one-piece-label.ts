// One Piece slab label wording, derived from the PriceCharting product name +
// console-name the way PSA prints it. Pure — no I/O. Verified 2026-10-25
// against ~70 real PSA 10 One Piece labels (eBay cert photos; the cert numbers
// are in one-piece-label.unit.spec.ts). Current PSA format, from certs between
// ~101.7M and ~108M on (100013247-101705096 still print the old "2024 ONE PIECE
// JPN." / "OP07-ALTERNATE ART" style; 107989941 is the earliest new one seen):
//
//   2024 ONE PIECE OP08 EN          #007
//   JEWELRY BONNEY                 GEM MT
//   SPECIAL ALTERNATE ART             10
//
// line 1  release year + "ONE PIECE" + the BOX the card came out of + EN/JP
// line 2  the name, uppercased, "Monkey.D.Luffy" printed "MONKEY D. LUFFY"
// line 3  the variety ("ALTERNATE ART", "SPECIAL ALTERNATE ART", …); none for
//         a plain card
// #       the card number without its set code (OP05-119 → #119)
//
// Promo / event / prize prints have no box: PSA prints "<year> ONE PIECE EN|JP"
// and the event as the variety (172653222, 156101387); see PROMO_YEAR. An unknown box keeps the
// plain fallback (the uppercased PriceCharting set, the bracket text as-is)
// rather than invented wording.
import {
  ONE_PIECE_REPRINTS,
  type ReprintKind,
} from './one-piece-reprints';

export type OnePieceLabel = {
  setLine: string; // "ONE PIECE OP08 EN" (year joins it in layoutLabel)
  year: string; // '' when this box's year isn't verified on a real slab
  name: string;
  number: string; // "#007"
  variety: string;
};

// PriceCharting console-name (without "One Piece " / "One Piece Japanese ")
// -> box code.
const BOX_BY_PC_SET: Record<string, string> = {
  'romance dawn': 'OP01',
  'paramount war': 'OP02',
  'pillars of strength': 'OP03',
  'kingdoms of intrigue': 'OP04',
  'awakening of the new era': 'OP05',
  'wings of the captain': 'OP06',
  '500 years in the future': 'OP07',
  'two legends': 'OP08',
  'emperors in the new world': 'OP09',
  'royal blood': 'OP10',
  'fist of divine speed': 'OP11',
  'legacy of the master': 'OP12',
  'carrying on his will': 'OP13',
  "azure sea's seven": 'OP14',
  "adventure on kami's island": 'OP15',
  'the time of battle': 'OP16',
  "world's strongest warriors": 'OP17',
  'extra booster memorial collection': 'EB01',
  'extra booster anime 25th collection': 'EB02',
  'extra booster heroines edition': 'EB03',
  'extra booster eb04': 'EB04',
  'extra booster egghead crisis': 'EB04',
  'premium booster': 'PRB01',
  'premium booster 2': 'PRB02',
  'ultra deck: the three captains': 'ST10',
};

// The year PSA prints for a box, per language — ONLY years seen on a real
// slab (cert in the comment). A box missing here prints no year unless the
// card's label year is set.
const YEAR: Record<string, string> = {
  'OP01 EN': '2022', // 168858816
  'OP02 EN': '2023', // 157473531
  'OP03 EN': '2023', // 170355125
  'OP04 EN': '2023', // 161294290
  'OP05 EN': '2023', // 161508846
  'OP06 EN': '2024', // 152131695
  'OP07 EN': '2024', // 148254266
  'OP08 EN': '2024', // 143928933
  'OP09 EN': '2024', // 153017919
  'OP10 EN': '2025', // 166574123
  'OP11 EN': '2025', // 168391843
  'OP12 EN': '2025', // 152097492
  'OP13 EN': '2025', // 149691008
  'OP14 EN': '2026', // 174657126
  'OP15 EN': '2026', // 164268585
  'OP16 EN': '2026', // 176409551
  'EB01 EN': '2024', // 157475597
  'EB02 EN': '2025', // 164564317
  'EB03 EN': '2026', // 165463221
  'PRB01 EN': '2024', // 165559351
  'PRB02 EN': '2025', // 162705703
  'ST01 EN': '2022', // 165922168
  'ST15 EN': '2024', // 109463159
  'ST21 EN': '2025', // 147492294
  'OP17 EN': '2026', // 179988487
  'OP03 JP': '2023', // 109725416
  'OP02 JP': '2022', // OP02 JP Sanji #026 (cert masked)
  'OP05 JP': '2023', // 165587545
  'OP06 JP': '2023', // OP06 JP Buggy #008 (cert masked)
  'OP08 JP': '2024', // 151228566
  'OP09 JP': '2024', // 165922172
  'OP10 JP': '2024', // OP10 JP Luffy #118 (cert masked)
  'OP11 JP': '2025', // OP11 JP Luffy #118 / Nami #041 (cert masked)
  'OP12 JP': '2025', // 132209275, 153851894
  'OP13 JP': '2025', // OP13 JP Ace #028 / Luffy #119 (cert masked)
  'OP14 JP': '2025', // 143857026, 150053399
  'OP15 JP': '2026', // OP15 JP Enel #118 (cert masked)
  'OP16 JP': '2026', // 163557203
  'OP17 JP': '2026', // OP17 JP Shanks #022 (cert masked)
  'EB01 JP': '2024', // 153608459
  'EB02 JP': '2025', // 115536799
  'EB04 JP': '2026', // 167127573
  'PRB01 JP': '2024', // 167949328
  'PRB02 JP': '2025', // 171270048
  'EB03 JP': '2025', // 173416523
};

// English OP14 / OP15 boxes carry the EB04 cards: PSA prints "OP14-EB04 EN"
// (174657126, 161337326) and "OP15-EB04 EN" (164268585, 171761178).
const boxLabel = (box: string, lang: string): string =>
  lang === 'EN' && (box === 'OP14' || box === 'OP15') ? `${box}-EB04` : box;

// Event / prize / promo prints: PSA labels them by event ("OFFICIAL EVENT
// PRIZE", "ILLUSTRATION BOX VOL.3", "CHAMPIONSHIP EVENT PACK"…) with no box
// code. The bracket text is printed as the variety, with PSA's own hyphens
// where a real slab showed them (promoVariety); the year comes from PROMO_YEAR
// or the set the event names. A typed label year / note still wins.
const PRIZE_RE =
  /serial|judge|winner|top prize|top 8|treasure cup|championship|flagship|promo|welcome pack|campaign|one piece day|illustration box|lecafig|dash pack|finalist|tournament|event|celebration|prize|gift collection|storage box|learn together|treasure chest|weekly shonen/i;

// PSA hyphenates an event from its prize or issue.
function promoVariety(bracket: string): string {
  return bracket
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase()
    .replace(/\bRELEASE EVENT WINNER$/, 'RELEASE EVENT-WINNER') // 172653222
    .replace(/^TREASURE CUP TOP PRIZE$/, 'TREASURE CUP-TOP PRIZE') // 144054482
    .replace(
      /^WEEKLY SHONEN JUMP (JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)$/,
      'WEEKLY SHONEN JUMP-$1',
    ); // 152236762
}

// The year PSA printed on an event print, per card (code, language, bracket as
// PriceCharting writes it): the event's year, not the card's set's, so it
// can't be derived ("Illustration Box Vol.3" OP07-109 is 2025, OP07 is 2024).
const PROMO_YEAR: Record<string, string> = {
  'ST03-008 EN CHAMPIONSHIP EVENT PACK': '2024', // 148696172
  'OP07-109 EN ILLUSTRATION BOX VOL.3': '2025', // 156604108
  'ST12-008 EN TREASURE CUP TOP PRIZE': '2024', // 144054482
  'ST13-015 JP 2ND ANNIVERSARY SET': '2024', // 156101387
  'ST21-014 JP ONE PIECE MAGAZINE VOL.20': '2025', // 134661995
  'ST21-014 JP OFFICIAL EVENT TOP PRIZE': '2025', // ST21 JP Luffy #014 (cert masked)
  'ST21-015 JP OFFICIAL EVENT PRIZE': '2025', // ST21 JP Zoro #015 (cert masked)
  'ST01-001 JP WEEKLY SHONEN JUMP JAN': '2023', // 152236762
};

const kindOf = (bracket: string): ReprintKind => {
  if (/wanted/i.test(bracket)) return 'wanted';
  if (/treasure rare|\bTR\b/i.test(bracket)) return 'tr';
  if (/\bSP\b|special/i.test(bracket)) return 'sp';
  if (/manga|comic/i.test(bracket)) return 'manga';
  if (/alt(ernate)?\s*art|parallel/i.test(bracket)) return 'aa';
  return 'base';
};

// PSA's variety line for a PriceCharting bracket (a box code already removed).
// EB02's reprints print plain "SPECIAL" (164564317, 168673768).
function varietyOf(bracket: string, box: string | null, reprint: boolean): string {
  const b = bracket
    .replace(/\bfoil\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  if (box === 'EB02' && reprint && (b === '' || /^(sp|special)$/.test(b))) {
    return 'SPECIAL';
  }
  if (b === '') return '';
  if (/^(alt(ernate)? art|parallel)$/.test(b)) return 'ALTERNATE ART'; // 168858816
  if (/^(manga|comic parallel|manga alt(ernate)? art|alt(ernate)? art manga)$/.test(b))
    return 'MANGA ALTERNATE ART'; // 165559351
  if (/^(sp|special|special alt(ernate)? art|sp alt(ernate)? art)$/.test(b))
    return 'SPECIAL ALTERNATE ART'; // 123824985
  if (/^wanted( poster)?$/.test(b)) return 'WANTED ALTERNATE ART'; // 107989941
  if (/^(treasure rare|tr)$/.test(b)) return 'TREASURE RARE'; // 143928933
  if (/^alt(ernate)? art errata$/.test(b)) return 'ALTERNATE ART-ERRATA'; // 137419797
  if (b === 'errata') return 'ERRATA'; // 162553499
  if (b === 'super pre-release') return 'SUPER PRE-RELEASE'; // 155704783
  if (b === '1st anniversary') return '1ST ANNIVERSARY'; // 160877854
  if (/^3rd anniversary[ -]gold$/.test(b)) return '3RD ANNIVERSARY-GOLD'; // OP11 JP Luffy #119 (cert masked)
  return bracket.trim().toUpperCase(); // unverified wording: as written
}

// "Monkey.D.Luffy" -> "MONKEY D. LUFFY", "Edward.Newgate" -> "EDWARD NEWGATE".
// A lookahead, so a one-character part ("Mr.3.Galdino") loses every dot; "Mr."
// keeps its period. PSA's own spellings: MR. 2 BON CLAY (148140147), KOZUKI
// (EB02 JP Kozuki Oden #001, cert masked).
const psaName = (name: string): string =>
  /^\s*mr\.?\s*2\.?\s*bon\.?\s*kurei\b/i.test(name)
    ? 'MR. 2 BON CLAY'
    : name
        .replace(/\bkouzuki\b/gi, 'Kozuki')
        .replace(/\.D\./g, ' D. ')
        .replace(/^(\s*M(?:r|s))\.(?=\S)/i, '$1. ')
        .replace(/(\w)\.(?=\w)/g, '$1 ')
        .replace(/\s+/g, ' ')
        .trim()
        .toUpperCase();

const CODE_RE = /\b((?:OP|ST|EB|PRB)\d{2})-(\d{3})\b/i;
const PROMO_CODE_RE = /\bP-(\d{3})\b/i; // "P-135" -> "#135" (172653222)

/** PSA wording for a One Piece card, or null for any other franchise. */
export function onePieceLabel(f: {
  set: string;
  name: string;
}): OnePieceLabel | null {
  const pcSet = f.set.trim().replace(/\s+/g, ' ');
  const m = pcSet.match(/^one piece\s+(japanese\s+)?(.*)$/i);
  if (!m) return null;
  const lang = m[1] ? 'JP' : 'EN';
  const rest = m[2].toLowerCase();
  const deck = rest.match(/^starter deck (?:ex )?(\d+)\b/);
  const pcBox =
    BOX_BY_PC_SET[rest] ?? (deck ? `ST${deck[1].padStart(2, '0')}` : null);

  // Name: "Monkey.D.Luffy [SP Gold] OP05-119", or typed "Shanks #120".
  let name = f.name.trim();
  const bracket = [...name.matchAll(/\[([^\]]*)\]/g)].map((x) => x[1]).join(' ');
  name = name.replace(/\[[^\]]*\]/g, ' ');
  let cardCode: string | null = null; // "OP05-119"
  let promoCode: string | null = null; // "P-135"
  let number = '';
  const hash = name.match(/\s*#\s*([A-Za-z0-9/-]+)\s*$/);
  if (hash) {
    name = name.slice(0, hash.index);
    const c = hash[1].match(CODE_RE);
    if (c) cardCode = `${c[1].toUpperCase()}-${c[2]}`;
    const promo = c ? null : hash[1].match(PROMO_CODE_RE);
    if (promo) promoCode = `P-${promo[1]}`;
    number = `#${c ? c[2] : promo ? promo[1] : hash[1]}`; // "#OP01-120" typed -> "#120"
  } else {
    const c = name.match(CODE_RE);
    const p = c ? null : name.match(PROMO_CODE_RE);
    if (c) cardCode = `${c[1].toUpperCase()}-${c[2]}`;
    if (p) promoCode = `P-${p[1]}`;
    const m = c ?? p;
    if (m) {
      number = `#${c ? c[2] : m[1]}`;
      name = name.replace(m[0], ' ');
    }
  }
  name = psaName(name);

  // Box code inside the bracket ("[Manga PRB01]", "[SP PRB-02]").
  const inBracket = bracket.match(/\b(PRB|OP|EB|ST)-?(\d{2})\b/i);
  const bracketBox = inBracket ? `${inBracket[1].toUpperCase()}${inBracket[2]}` : null;
  const kindText = bracket.replace(/\b(PRB|OP|EB|ST)-?\d{2}\b/gi, ' ').trim();

  const plain = (): OnePieceLabel => ({
    setLine: pcSet.toUpperCase(),
    year: '',
    name,
    number,
    variety: bracket.trim().toUpperCase(),
  });
  // A Promo-set card keeps the promo line even with a booster code: PSA prints
  // "ONE PIECE JP" for ST13-015 (156101387) and ST21-014 (134661995).
  if (PRIZE_RE.test(bracket) || /\bpromo\b/.test(rest)) {
    const key = `${cardCode ?? promoCode} ${lang} ${bracket.replace(/\s+/g, ' ').trim().toUpperCase()}`;
    // "[OP16 Release Event Winner]": the event ran at that set's release (172653222).
    const year = PROMO_YEAR[key] ?? (bracketBox ? (YEAR[`${bracketBox} ${lang}`] ?? '') : '');
    return { setLine: `ONE PIECE ${lang}`, year, name, number, variety: promoVariety(bracket) };
  }

  // Which box the card came out of.
  const own = cardCode?.split('-')[0] ?? null; // the card's own set, "OP05"
  const kind = kindOf(kindText);
  let box: string | null = null;
  if (bracketBox) box = bracketBox;
  else if (pcBox && own && pcBox !== own) box = pcBox; // filed under its box
  else if (cardCode && own && (kind !== 'base' || (own === 'EB04' && lang === 'EN'))) {
    // PriceCharting filed a reprint under its ORIGINAL set: ask the Limitless
    // print list. Premium Booster reprints always say so in the bracket, and
    // Japanese EB04 is its own box (only English bundles it into OP14/OP15).
    const prints = ONE_PIECE_REPRINTS[cardCode];
    if (!(own === 'EB04' && lang === 'JP') && prints) {
      const pick = (kinds: ReprintKind[]) => [
        ...new Set(kinds.flatMap((k) => prints[k] ?? []).filter((b) => !b.startsWith('PRB'))),
      ];
      // Limitless files TR prints under "sp": SP / TR / Wanted are one family.
      let boxes = pick([kind]);
      if (boxes.length === 0 && (kind === 'sp' || kind === 'tr' || kind === 'wanted'))
        boxes = pick(['sp', 'tr', 'wanted']);
      if (boxes.length === 1) box = boxes[0];
    }
    if (!box) box = pcBox;
  } else box = pcBox;
  if (!box) return plain();

  const reprint = own !== null && own !== box;
  return {
    setLine: `ONE PIECE ${boxLabel(box, lang)} ${lang}`,
    year: YEAR[`${box} ${lang}`] ?? '',
    name,
    number,
    variety: varietyOf(kindText, box, reprint),
  };
}

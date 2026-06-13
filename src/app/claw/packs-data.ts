// Shared /claw pack catalog — consumed by the claw list page AND the [slug] detail
// template. Pack `id` doubles as the route slug (/claw/<id>).
//
// NOTE (frontend-first): the pack art, prices, and categories are real (extracted from
// the live /claw). The card pool, odds, and "recent pulls" below are MOCK for layout —
// the real weighted odds + pull results come from the backend Packs module + open-pack
// workflow (BUILD_PLAN Phase 5). Do not treat these odds as authoritative.

/** Site-wide flat buyback % — what every sell from the vault/inventory pays.
 *  Mirrors FLAT_PERCENT in backend/packages/api/src/modules/packs/buyback-rate.ts. */
export const FLAT_BUYBACK_PERCENT = 90;

export type Pack = {
  id: string;
  name: string;
  price: string;
  /** Path under /public — verified to exist in public/images/claw/. */
  image: string;
  /** Shows the green buyback-boost badge on the card. */
  boost?: boolean;
  /** INSTANT ("sell on the spot") buyback % — also the boost-badge number
   *  (default 90 = the flat rate; premium Black/Diamond = 92). Later sells
   *  from the vault always pay FLAT_BUYBACK_PERCENT. */
  buybackPercent?: number;
  /** false → render a greyed "Out of Stock" / "Sold out" tile. Default in-stock. */
  inStock?: boolean;
};

export type PackCategory = {
  id: string;
  /** Tab label in the top filter bar. */
  tab: string;
  /** Section heading above the grid. */
  heading: string;
  /** Small category badge icon. */
  icon: string;
  packs: Pack[];
};

// Category badge icons (localized to public/pack-index-icons/).
export const CAT_ICON = {
  pokemon: '/pack-index-icons/pokemon.webp',
} as const;

// Real categories, packs, prices, and artwork extracted from the live /claw DOM.
export const CATEGORIES: PackCategory[] = [
  {
    id: 'pokemon',
    tab: 'Pokémon',
    heading: 'Pokémon Packs',
    icon: CAT_ICON.pokemon,
    packs: [
      {
        id: 'pokemon-black',
        name: 'Black Pack',
        price: '$2,500',
        image: '/images/claw/black-pack-icon.webp',
        boost: true,
        buybackPercent: 92,
      },
      {
        id: 'pokemon-diamond',
        name: 'Diamond Pack',
        price: '$5,000',
        image: '/images/claw/diamond-pack-icon.webp',
        boost: true,
        buybackPercent: 92,
      },
      {
        id: 'pokemon-mythic',
        name: 'Mythic Pack',
        price: '$1,000',
        image: '/images/claw/mythic-pack-icon.webp',
        boost: true,
      },
      {
        id: 'pokemon-legend',
        name: 'Legend Pack',
        price: '$250',
        image: '/images/claw/legend-pack-icon.webp',
        boost: true,
      },
      {
        id: 'pokemon-elite',
        name: 'Elite Pack',
        price: '$50',
        image: '/images/claw/elite-pack-icon.webp',
      },
      {
        id: 'pokemon-platinum',
        name: 'Platinum Pack',
        price: '$500',
        image: '/images/claw/platinum-pack-icon.webp',
        boost: true,
      },
      {
        id: 'pokemon-rookie',
        name: 'Rookie Pack',
        price: '$25',
        image: '/images/claw/rookie-pack-icon.webp',
      },
      {
        id: 'pokemon-trainer',
        name: 'Trainer Pack',
        price: '$10',
        image: '/images/claw/trainer-pack-icon.webp',
        inStock: false,
      },
    ],
  },
];

export type ResolvedPack = Pack & {
  categoryId: string;
  categoryName: string;
  icon: string;
};

export const ALL_PACKS: ResolvedPack[] = CATEGORIES.flatMap((c) =>
  c.packs.map((p) => ({
    ...p,
    categoryId: c.id,
    categoryName: c.tab,
    icon: c.icon,
  })),
);

export function findPack(slug: string): ResolvedPack | null {
  return ALL_PACKS.find((p) => p.id === slug) ?? null;
}

export function findCategory(slug: string): PackCategory | null {
  return CATEGORIES.find((c) => c.packs.some((p) => p.id === slug)) ?? null;
}

// ---------------------------------------------------------------------------
// Claw-machine hero render — the iridescent 3D machine shown on the detail page
// (the live site's centerpiece). Derived from each pack's icon basename:
//   {base}-icon.webp  ->  {base}-machine.avif / .webp   (in public/images/claw/)
// 13 packs also ship a high-res .avif; the rest are webp-only.
// ---------------------------------------------------------------------------
// Machines that ship a REBRANDED ANIMATED avif ({base}-anim.avif) — the live claw render is an
// animated AVIF (claw slides L-R inside the file); these are rebranded frame-by-frame. The rest
// fall back to the static rebranded webp.
const CLAW_HAS_ANIM = new Set([
  'mythic-pack',
  'legend-pack',
  'elite-pack',
  'platinum-pack',
  'rookie-pack',
  'trainer-pack',
  // premium pokemon tiers: full banner+placard+url rebrand on the busy red-neon / crystal-refraction
  // backgrounds (scripts/rebrand-premium-banner.mjs blur-patch + make_patch per-base BAND).
  'black-pack',
  'diamond-pack',
]);

// Packs that ship NO rebranded claw-machine render yet. Empty now that the premium tiers are baked;
// kept as a guard so a future un-rebranded pack can fall back to its brand-consistent icon instead
// of a phygitals-branded machine.
const CLAW_NO_MACHINE = new Set<string>([]);

// Bump CLAW_REV whenever the machine pixels change (rebrand passes) so browsers fetch the new
// image instead of a cached older one (filenames stay the same across edits).
const CLAW_REV = '17';

export function clawMachine(pack: Pack): { webp: string; anim?: string } {
  const base = pack.image
    .replace('/images/claw/', '')
    .replace('-icon.webp', '');
  if (CLAW_NO_MACHINE.has(base)) return { webp: pack.image };
  return {
    webp: `/images/claw/${base}-machine.webp?v=${CLAW_REV}`,
    anim: CLAW_HAS_ANIM.has(base)
      ? `/images/claw/${base}-anim.avif?v=${CLAW_REV}`
      : undefined,
  };
}

/** Numeric price, e.g. "$1,000" -> 1000. */
export function priceNumber(price: string): number {
  return parseFloat(price.replace(/[$,]/g, '')) || 0;
}

// ---------------------------------------------------------------------------
// MOCK card pool / odds (layout only — real data comes from the backend).
// ---------------------------------------------------------------------------

export type Rarity = 'Legendary' | 'Epic' | 'Rare' | 'Uncommon' | 'Common';
export type PackCard = {
  id: string;
  name: string;
  image: string;
  value: string;
  rarity: Rarity;
};

const cardImg = (id: string) => `/cdn/cards/${id}.webp`;

// Real localized graded-card art (shared with Recent Pulls / Marketplace).
export const CARD_POOL: PackCard[] = [
  {
    id: 'celebi',
    name: 'Jet-Black Spirit Celebi V CGC 10',
    image: cardImg('FQEYWuGiKTkJpZSG6XqGHDBmH6EmxctEqk1kAT2MYzHc'),
    value: '$912.00',
    rarity: 'Legendary',
  },
  {
    id: 'mewtwo',
    name: 'Rocket Gang Mewtwo ex CGC 10',
    image: cardImg('9kRLkdbbvzm335GBvraQrWrNVs72gzEzynvP1RPvftTx'),
    value: '$540.00',
    rarity: 'Epic',
  },
  {
    id: 'darkrai',
    name: 'Crown Zenith Darkrai VSTAR PSA 10',
    image: cardImg('4h13RDtFX4MWNYjvgMPeBS1hcL4AewupiFzDvyFUUTkd'),
    value: '$318.00',
    rarity: 'Epic',
  },
  {
    id: 'jolteon',
    name: 'Terastal Fest Jolteon ex CGC 10',
    image: cardImg('BEnddEeBXBHyL5qWXCg6sKS5VmUbUtZaKJ1aVB8yCWHN'),
    value: '$156.00',
    rarity: 'Rare',
  },
  {
    id: 'rapidash',
    name: 'Mega Start Deck Rapidash CGC 10',
    image: cardImg('FFbo5jfXHHQWN8bmc88UDYSDP5QzYCCj6RwUkiWYyffC'),
    value: '$84.50',
    rarity: 'Uncommon',
  },
  {
    id: 'hooh',
    name: 'Incandescent Arcana Ho-Oh V CGC 10',
    image: cardImg('FjAJZ7en585MpnoLUGbuALHEmbBAPd61EZCefQzFMmRX'),
    value: '$213.00',
    rarity: 'Rare',
  },
  {
    id: 'gengar',
    name: 'Scarlet & Violet 151 Gengar CGC 10',
    image: cardImg('6noxMybjBLtLqicAUTrG63VhWG2FgWzDBsQGnnZEyNCG'),
    value: '$299.00',
    rarity: 'Epic',
  },
];

// Per-rarity pull odds (MOCK — published transparently by the backend in production).
export const ODDS: { rarity: Rarity; chance: string; dot: string }[] = [
  { rarity: 'Legendary', chance: '0.5%', dot: 'bg-amber-400' },
  { rarity: 'Epic', chance: '4.5%', dot: 'bg-fuchsia-400' },
  { rarity: 'Rare', chance: '15%', dot: 'bg-sky-400' },
  { rarity: 'Uncommon', chance: '30%', dot: 'bg-emerald-400' },
  { rarity: 'Common', chance: '50%', dot: 'bg-neutral-400' },
];

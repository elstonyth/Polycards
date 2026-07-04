// Pack catalog TYPES + presentational category meta (labels/icons) + the
// statically-published odds display. Pack `id` doubles as the route slug
// (/slots/<id>).
//
// NOTE: the LIVE pack list comes entirely from the backend (the source of
// truth) via src/lib/data/packs.ts — the static pack entries below are never
// rendered as catalog; they only back `findPack` label lookups (recent-pull
// pack names/icons) until that feed resolves labels from the backend too.

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
        price: 'RM 2,500',
        image: '/images/claw/black-pack-icon.webp',
        boost: true,
        buybackPercent: 92,
      },
      {
        id: 'pokemon-diamond',
        name: 'Diamond Pack',
        price: 'RM 5,000',
        image: '/images/claw/diamond-pack-icon.webp',
        boost: true,
        buybackPercent: 92,
      },
      {
        id: 'pokemon-mythic',
        name: 'Mythic Pack',
        price: 'RM 1,000',
        image: '/images/claw/mythic-pack-icon.webp',
        boost: true,
      },
      {
        id: 'pokemon-legend',
        name: 'Legend Pack',
        price: 'RM 250',
        image: '/images/claw/legend-pack-icon.webp',
        boost: true,
      },
      {
        id: 'pokemon-elite',
        name: 'Elite Pack',
        price: 'RM 50',
        image: '/images/claw/elite-pack-icon.webp',
      },
      {
        id: 'pokemon-platinum',
        name: 'Platinum Pack',
        price: 'RM 500',
        image: '/images/claw/platinum-pack-icon.webp',
        boost: true,
      },
      {
        id: 'pokemon-rookie',
        name: 'Rookie Pack',
        price: 'RM 25',
        image: '/images/claw/rookie-pack-icon.webp',
      },
      {
        id: 'pokemon-trainer',
        name: 'Trainer Pack',
        price: 'RM 10',
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
  // Machine renders are hand-rebranded static assets keyed to the baked pack
  // icon basenames (/images/claw/{base}-icon.webp). A backend-created pack ships
  // its own uploaded art (CDN URL or other path) and has no {base}-machine
  // asset, so fall back to the pack image as the hero instead of a broken path.
  const isBaked =
    pack.image.startsWith('/images/claw/') && pack.image.endsWith('-icon.webp');
  if (!isBaked) return { webp: pack.image };
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

/** Numeric price, e.g. "RM 1,000" -> 1000. */
export function priceNumber(price: string): number {
  return parseFloat(price.replace(/^RM\s*/, '').replace(/,/g, '')) || 0;
}

// ---------------------------------------------------------------------------
// Card display types + the statically-published odds (real pool data comes
// from the backend — the storefront renders no mock cards).
// ---------------------------------------------------------------------------

export type Rarity =
  | 'Immortal'
  | 'Legendary'
  | 'Mythical'
  | 'Rare'
  | 'Uncommon'
  | 'Common';
export type PackCard = {
  id: string;
  name: string;
  image: string;
  value: string;
  rarity: Rarity;
};

// Per-rarity pull odds — the statically-PUBLISHED display, decoupled by design
// from the backend's secret per-card weights (admin-configurable in Step 4).
// All six tiers, rarest first; dots match RARITY_RGB in src/lib/rarity.ts.
export const ODDS: { rarity: Rarity; chance: string; dot: string }[] = [
  { rarity: 'Immortal', chance: '0.1%', dot: 'bg-orange-400' },
  { rarity: 'Legendary', chance: '0.4%', dot: 'bg-pink-500' },
  { rarity: 'Mythical', chance: '4.5%', dot: 'bg-purple-500' },
  { rarity: 'Rare', chance: '15%', dot: 'bg-blue-600' },
  { rarity: 'Uncommon', chance: '30%', dot: 'bg-sky-400' },
  { rarity: 'Common', chance: '50%', dot: 'bg-neutral-400' },
];

// Pack catalog TYPES + presentational category meta (labels/icons) + the
// statically-published odds display. Pack `id` doubles as the route slug
// (/slots/<id>).
//
// NOTE: there is no static pack list here any more. Every pack the storefront
// renders comes from the backend via src/lib/data/packs.ts; the only local data
// left is the category chrome (tab label, heading, icon) that wraps it.
import type { CardView } from '@/lib/card-view';
import { mediaHost } from '@/lib/security/csp';

/** Site-wide flat buyback % — what every sell from the vault/inventory pays.
 *  Mirrors FLAT_PERCENT in backend/packages/api/src/modules/packs/buyback-rate.ts. */
export const FLAT_BUYBACK_PERCENT = 90;

/** The reserved category of the one-time free welcome pack. Mirrors
 *  FREE_WELCOME_CATEGORY in backend/packages/api/src/modules/packs/free-pack.ts.
 *  A pack in it is free (price 0), hidden from the catalog, opened once, and
 *  its pull is sell/deliver-locked until the account's first PAID open. */
export const FREE_WELCOME_CATEGORY = 'free_welcome';

/** Shown wherever a locked free pull's sell/deliver is refused. Must stay
 *  VERBATIM equal to FREE_PULL_LOCKED_MESSAGE in the backend's free-pack.ts —
 *  the server returns this exact string on a refused sell/deliver, so the
 *  storefront's pre-emptive copy has to read identically. */
export const FREE_PULL_LOCKED_MESSAGE =
  'Pay for one pack yourself to unlock selling & delivery.';

/** What the backend claim step still refuses for (spec 2026-10-06). */
export type FreePackRequirement = 'phone' | 'real_name';

/** The prompt the free pack's detail page shows instead of opening, naming
 *  exactly what is left (spec 2026-10-06). Client-safe, which is why it lives
 *  here and not in the server-only data/free-pack.ts. */
export function freePackVerifyMessage(missing: FreePackRequirement[]): string {
  const phone = missing.includes('phone');
  const name = missing.includes('real_name');
  const todo =
    phone && name
      ? 'verify your phone number and add your real name'
      : phone
        ? 'verify your phone number'
        : 'add your real name';
  return `To claim your welcome pack, ${todo} in Settings.`;
}

export type Pack = {
  id: string;
  name: string;
  /** The pack's real price in RM, straight from the backend. Every cost/afford
   *  calculation (bet meter, canAfford, shortfall) reads this; the tiles render
   *  it with `rm0()` — the rounded "RM 2" for a RM 1.50 pack is display only
   *  and never exists as data, so nothing can parse it back and gate at 2. */
  priceMyr: number;
  /** Pack shot — /public path (public/images/polycards/) or an uploaded URL. */
  image: string;
  /** Pack-page HERO scene (wide landscape "factory" render, may be animated).
   *  Only the /slots/<slug> stage uses it; tiles/selector always use `image`.
   *  Absent → the stage falls back to the pack image. */
  displayImage?: string;
  /** Shows the green buyback-boost badge on the card. */
  boost?: boolean;
  /** INSTANT ("sell on the spot") buyback % — also the boost-badge number
   *  (default 90 = the flat rate). Later sells from the vault always pay
   *  FLAT_BUYBACK_PERCENT. */
  buybackPercent?: number;
  /** false → render a greyed "Out of Stock" / "Sold out" tile. Default in-stock. */
  inStock?: boolean;
  /** §2.4.8 pool composition, auto-detected by the backend from the pack's
   *  prize pool — never operator-set. GRADED = every card graded (the catalog's
   *  "Guaranteed PSA 10" section), RAW = none graded, MIX = both, null/absent =
   *  empty pool or an older backend. Anything but GRADED lists under Raw:
   *  the PSA 10 guarantee heading must never cover a pack with an ungraded
   *  card in its pool. */
  group?: 'GRADED' | 'RAW' | 'MIX' | null;
  /** Strict guarantee gate, backend-derived: true iff EVERY pooled card is a
   *  PSA 10. Stricter than `group === 'GRADED'` — an all-graded pack holding
   *  a PSA 9 or a BGS slab is GRADED but NOT psa10. Absent/false on an older
   *  backend, which errs in the never-overclaim direction. */
  psa10?: boolean;
  /** Set when the pack pays Lucky Draw tickets instead of cards. Absent on a
   *  card pack and on an older backend. */
  prizeType?: 'tickets';
};

/** A ticket pack has no card to show, value or sell (spec 2026-10-30). */
export const isTicketPack = (p: Pick<Pack, 'prizeType'>): boolean =>
  p.prizeType === 'tickets';

/** Where to spin for tickets, or null with no ticket pack on sale (a Draft one
 *  never reaches the catalog). */
export const ticketPackHref = (
  categories: { id: string; packs: Pick<Pack, 'prizeType'>[] }[],
): string | null => {
  const category = categories.find((c) => c.packs.some(isTicketPack));
  return category ? `/slots?category=${category.id}` : null;
};

/** Membership rule for the catalog's "Graded (Guaranteed PSA 10)" section —
 *  BOTH gates: every pooled card graded AND every one a PSA 10. Everything
 *  else (RAW, MIX, empty, non-PSA-10 graded, older backend) lists under
 *  "Raw Cards (Ungraded)" so the guarantee heading can never overclaim. */
export const inGuaranteedGroup = (p: Pack): boolean =>
  p.group === 'GRADED' && p.psa10 === true;

/** Three-way catalog section a pack belongs in — first match wins, nothing
 *  ever moves INTO the guarantee bucket:
 *  - 'graded' — `inGuaranteedGroup` (unchanged, still the only truth-critical
 *    gate backing the "Guaranteed PSA 10" copy).
 *  - 'raw' — `group === 'RAW'` ONLY. This is now a backend-derived fact, so
 *    "Raw Cards (Ungraded)" claims exactly what it says.
 *  - 'more' — everything uncertain: MIX, non-PSA-10 GRADED (a PSA 9/BGS pool
 *    is NOT raw — mislabeling it "Ungraded" would be its own overclaim),
 *    null/absent group (empty pool or an older backend that never sent
 *    composition). None of these can be described with a claim that's
 *    guaranteed true, so they land in the claim-free "More Packs" bucket. */
export type CatalogGroup = 'graded' | 'raw' | 'more';
export const catalogGroupOf = (p: Pack): CatalogGroup => {
  if (inGuaranteedGroup(p)) return 'graded';
  if (p.group === 'RAW') return 'raw';
  return 'more';
};

/** Section order + heading, shared by the /slots catalog sections and the pack
 *  detail page's sibling selector. ONE copy on purpose: these headings are
 *  truth claims about pool composition (see catalogGroupOf), and a second copy
 *  is how one surface drifts into an overclaim the other never makes. The
 *  qualifying notes ("Guaranteed PSA 10" / "Ungraded") stay in the catalog —
 *  they need the room only that page has. */
export const CATALOG_GROUP_ORDER: readonly CatalogGroup[] = [
  'graded',
  'raw',
  'more',
];
export const CATALOG_GROUP_HEADING: Record<CatalogGroup, string> = {
  graded: 'Graded',
  raw: 'Raw Cards',
  more: 'More Packs',
};

/** Split a pack list into its composition sections, in CATALOG_GROUP_ORDER,
 *  dropping the empty ones. Order WITHIN a group is the caller's (backend
 *  rank), and every input pack lands in exactly one group — 'more' is the
 *  catch-all, so a section-per-group render can never lose a pack. Backs the
 *  pack detail page's selector rails. */
export function groupPacks(
  packs: Pack[],
): { id: CatalogGroup; packs: Pack[] }[] {
  const by: Record<CatalogGroup, Pack[]> = { graded: [], raw: [], more: [] };
  for (const p of packs) by[catalogGroupOf(p)].push(p);
  return CATALOG_GROUP_ORDER.filter((id) => by[id].length > 0).map((id) => ({
    id,
    packs: by[id],
  }));
}

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

// Category badge icons (localized to public/pack-index-icons/), keyed by the
// admin's pack category keys.
export const CAT_ICON = {
  pokemon: '/pack-index-icons/pokemon.webp',
  'one-piece': '/pack-index-icons/onepiece.webp',
  basketball: '/pack-index-icons/nba.webp',
  baseball: '/pack-index-icons/mlb.webp',
  football: '/pack-index-icons/nfl.webp',
  soccer: '/pack-index-icons/soccer.webp',
  yugioh: '/pack-index-icons/yugioh.webp',
  riftbound: '/pack-index-icons/riftbound.webp',
  poly: '/pack-index-icons/poly.webp',
} as const;

/** The category a pack list opens on: `wanted` when it has packs, else the
 *  first category that does (catalog order, so Pokémon leads). Every surface
 *  shows ONE franchise at a time — mixing them is what buried the list. */
export const pickCategory = (
  categories: PackCategory[],
  wanted?: string,
): string | undefined =>
  categories.find((c) => c.id === wanted && c.packs.length > 0)?.id ??
  categories.find((c) => c.packs.length > 0)?.id;

// Category chrome only — getPackCategories fills `packs` from the backend.
// Listed order is tab order (operator 2026-10-30): Pokémon, One Piece, Poly on
// the far right. Each always has a tab; see packTabs.
export const CATEGORIES: Omit<PackCategory, 'packs'>[] = [
  {
    id: 'pokemon',
    tab: 'Pokémon',
    heading: 'Pokémon Packs',
    icon: CAT_ICON.pokemon,
  },
  {
    id: 'one-piece',
    tab: 'One Piece',
    heading: 'One Piece Packs',
    icon: CAT_ICON['one-piece'],
  },
  {
    id: 'poly',
    tab: 'Poly',
    heading: 'Poly Packs',
    icon: CAT_ICON.poly,
  },
];

export type PackTab = Pick<PackCategory, 'id' | 'tab' | 'icon'> & {
  /** No active pack yet: shown as "Coming soon", can't be picked. */
  soon: boolean;
};

/** The franchise switch's tabs. A category with no active pack stays on the row
 *  as "Coming soon" and opens by itself once admin activates a pack in it. Empty
 *  when no category has a pack: a backend outage empties them all, and that must
 *  not announce every franchise as coming soon. */
export const packTabs = (categories: PackCategory[]): PackTab[] =>
  categories.some((c) => c.packs.length > 0)
    ? categories.map(({ id, tab, icon, packs }) => ({
        id,
        tab,
        icon,
        soon: packs.length === 0,
      }))
    : [];

export type ResolvedPack = Pack & {
  categoryId: string;
  categoryName: string;
  icon: string;
};

/** A pack's detail-page URL, opened on `qty`. `Pack.id` IS the backend slug, so
 *  encode it — an operator-created slug carrying `?`, `#` or a space would
 *  otherwise build a broken link. Shared by the /slots catalog and the home
 *  ladder so the two can't drift on shape or encoding. */
export function packHref(id: string, qty: number): string {
  return `/slots/${encodeURIComponent(id)}?count=${qty}`;
}

// Tiers that ship an animated factory hero loop
// (public/images/polycards/{tier}-factory.{mp4,webm} + -poster.webp).
const FACTORY_VIDEO_TIERS = new Set([
  'bronze',
  'silver',
  'gold',
  'platinum',
  'diamond',
  // Set packs (not a price tier) — themed factory dioramas.
  'ascended',
  'celebration',
  'poncho',
  'chaos',
  'kanto',
  'lucky',
  // Capsules (ticket packs). Their own names: a capsule shares its metal with a
  // card tier above, and gold-factory is the card Gold pack's loop.
  'capsulebronze',
  'capsulesilver',
  'capsulegold',
  'capsuleplatinum',
  'capsulediamond',
]);

/** Animated factory-hero sources for a pack, or null when its display image is
 *  not a registered factory scene. Admin uploads of `{tier}-factory.webp`
 *  retain their baked loop; arbitrary heroes stay still. Poster is frame one. */
export function factoryVideo(
  displayImage: string | undefined,
): { mp4: string; webm: string; poster: string } | null {
  if (!displayImage) return null;
  const uploadPrefix = `https://${mediaHost()}/`;
  const uploadedFile = displayImage.startsWith(uploadPrefix)
    ? displayImage.slice(uploadPrefix.length)
    : '';
  const tier =
    /^\/images\/polycards\/([a-z]+)-factory\.webp$/.exec(displayImage)?.[1] ??
    /^([a-z]+)-factory-[0-9A-Z]{26}\.webp$/.exec(uploadedFile)?.[1];
  if (!tier || !FACTORY_VIDEO_TIERS.has(tier)) return null;
  const base = `/images/polycards/${tier}-factory`;
  return {
    mp4: `${base}.mp4`,
    webm: `${base}.webm`,
    poster: `${base}-poster.webp`,
  };
}

// ---------------------------------------------------------------------------
// Card display types + the statically-published odds (real pool data comes
// from the backend — the storefront renders no mock cards).
// ---------------------------------------------------------------------------

export type Rarity =
  'Immortal' | 'Legendary' | 'Mythical' | 'Rare' | 'Uncommon' | 'Common';
/** A card of a pack's prize pool (and, since the reveal shows the same shape,
 *  a won card — `WonCard` in actions/packs.ts is this type). The pool row's
 *  tier is REQUIRED: the odds schema drops a row without one, so unlike the
 *  base `CardView` this never renders frameless. `tickets` is set only on a
 *  ticket pack's row: the amount it pays, and what tells the reel and the reveal
 *  this is no card. */
export type PackCard = CardView & { rarity: Rarity; tickets?: number };

export const TICKET_ART = '/images/lucky-draw/ticket.webp';

/** "1 ticket", "1,000 tickets". */
export const ticketCount = (n: number): string =>
  `${n.toLocaleString('en-US')} ${n === 1 ? 'ticket' : 'tickets'}`;

/** Tickets a batch paid; 0 means it was cards. */
export const ticketTotal = (cards: readonly Pick<PackCard, 'tickets'>[]) =>
  cards.reduce((sum, c) => sum + (c.tickets ?? 0), 0);

/** A ticket amount in the one shape the reel, the demo and the reveal read. No
 *  price on purpose: every value sum in the storefront skips an unpriced row, so
 *  a ticket can't reach Expected value, the value ranges or a home highlight. */
export function ticketCard(tickets: number, rarity: Rarity): PackCard {
  return {
    handle: `tickets-${tickets}`,
    name: ticketCount(tickets),
    image: TICKET_ART,
    slabImage: null,
    rarity,
    priceMyr: null,
    pokemonDex: null,
    spriteImage: TICKET_ART,
    tickets,
  };
}

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

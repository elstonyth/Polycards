import { bestRarity, type Rarity } from './rarity';

/** A card in more packs than this is not a real catalogue shape; the cap keeps
 *  one lookup from scanning an unbounded odds table. */
export const ODDS_SCAN_MAX = 50;
/** Handles per query. The `take` below is ODDS_SCAN_MAX × this, so the cap is
 *  PER CARD rather than shared: one global LIMIT over many handles could spend
 *  its whole budget on the first few cards and leave later ones with no rows at
 *  all, resolving a framed card to null. Small enough to keep each query
 *  bounded, large enough that a normal vault needs one or two. */
const HANDLES_PER_QUERY = 10;

// Type-only import: erased at runtime, so no module cycle with the service.
type PacksLike = Pick<
  import('./service').default,
  'listPackOdds' | 'listPacks'
>;

/**
 * Display tier for cards shown OUTSIDE a pack context (deep links, the vault).
 *
 * Rarity is a PACK-level property and a card can sit in several packs at
 * different tiers, so there is no single answer — this picks the best tier the
 * card holds in a pack customers can actually OPEN. "Openable" means what the
 * public catalogue means by it (api/store/packs/route.ts): active and not a
 * reward_box, which is an internal draw pool. Falling back to every row keeps a
 * draft-only card framed rather than blank.
 *
 * Shared so the card page and the vault can never disagree about the same
 * card's tier — they showed different frames before this existed.
 */
export async function bestLiveTierByHandle(
  packs: PacksLike,
  handles: readonly string[],
): Promise<Map<string, Rarity | null>> {
  const out = new Map<string, Rarity | null>();
  const unique = [...new Set(handles)].filter(Boolean);
  if (unique.length === 0) return out;

  type OddsRow = Awaited<ReturnType<PacksLike['listPackOdds']>>[number];
  const oddsRows: OddsRow[] = [];
  for (let i = 0; i < unique.length; i += HANDLES_PER_QUERY) {
    const chunk = unique.slice(i, i + HANDLES_PER_QUERY);
    const rows = await packs.listPackOdds(
      { card_id: chunk },
      {
        take: chunk.length * ODDS_SCAN_MAX,
        // Ordered even under the cap: an unordered LIMIT is nondeterministic in
        // Postgres, which would let a card's frame flicker between tiers.
        order: { created_at: 'ASC' },
      },
    );
    oddsRows.push(...rows);
  }
  const packSlugs = [...new Set(oddsRows.map((o) => o.pack_id))];
  const livePacks = packSlugs.length
    ? await packs.listPacks(
        {
          slug: packSlugs,
          status: 'active',
          category: { $ne: 'reward_box' },
        },
        { take: packSlugs.length, select: ['slug'] },
      )
    : [];
  const liveSlugs = new Set(livePacks.map((p) => p.slug));

  for (const handle of unique) {
    const rows = oddsRows.filter((o) => o.card_id === handle);
    const live = rows.filter((o) => liveSlugs.has(o.pack_id));
    out.set(
      handle,
      bestRarity((live.length > 0 ? live : rows).map((o) => o.rarity)),
    );
  }
  return out;
}

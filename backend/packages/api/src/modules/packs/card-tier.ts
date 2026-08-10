import { bestRarity, type Rarity } from './rarity';

/** A card in more packs than this is not a real catalogue shape; the cap keeps
 *  one lookup from scanning an unbounded odds table. */
export const ODDS_SCAN_MAX = 50;
/** Ceiling for a batched lookup, so a big vault page can't fan out unbounded. */
const ODDS_BATCH_MAX = 500;

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

  const oddsRows = await packs.listPackOdds(
    { card_id: unique },
    {
      take: Math.min(unique.length * ODDS_SCAN_MAX, ODDS_BATCH_MAX),
      // Ordered even under the cap: an unordered LIMIT is nondeterministic in
      // Postgres, which would let a card's frame flicker between tiers.
      order: { created_at: 'ASC' },
    },
  );
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

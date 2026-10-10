import type { MedusaRequest } from '@medusajs/framework/http';
import type PacksModuleService from '../../../../modules/packs/service';
import {
  cardByHandle,
  makeRarityOf,
} from '../../../../modules/packs/card-view';
import type { Rarity } from '../../../../modules/packs/rarity';
import { stripAutolinks } from '../../../../modules/packs/telegram';
import { loadPullerProfiles } from '../../../store/pulls/pullers';

export type TopPull = {
  rank: number;
  pull_id: string;
  pulled_at: string;
  card: {
    handle: string;
    name: string;
    /** 'PSA 10'; '' for a raw card. */
    grade: string;
    grader: string;
    set: string;
    rarity: string;
    image: string | null;
    slab_image: string | null;
  };
  pack: { slug: string; title: string | null; image: string | null };
  /** The pull's pulled value in RM, as the Ranks page counts it. */
  value_myr: number;
  /** The public name the Telegram channel and the live feed show. */
  player: { name: string; handle: string | null };
  /** Internal, for the staff Excel: never in a public answer. */
  customer_id: string;
};

/** A day's top paid pulls with what a post needs about each: the card, its
 *  tier in that pack, the pack and the player's public name. Disabled players
 *  are left out, as on every public surface (the over-fetch keeps the list
 *  full when one is). `only` narrows the pulls before the limit applies (see
 *  topPullsInWindow); without it, every paid pull competes. */
export async function loadTopPulls(
  req: MedusaRequest,
  packs: PacksModuleService,
  window: { from: Date; to: Date },
  limit: number,
  only: { tiers?: readonly Rarity[]; defaultGroupOnly?: boolean } = {},
): Promise<TopPull[]> {
  const rows = await packs.topPullsInWindow({
    ...window,
    ...only,
    limit: limit + 20,
  });
  const pullers = await loadPullerProfiles(
    req,
    packs,
    rows.map((r) => r.customer_id),
  );
  const shown = rows
    .filter((r) => !pullers.disabled.has(r.customer_id))
    .slice(0, limit);
  const handles = [...new Set(shown.map((r) => r.card_id))];
  const slugs = [...new Set(shown.map((r) => r.pack_id))];
  // Odds: one live row per (pack, card), so the take is exact. A short read
  // would fall back to 'Common' and mislabel the pull.
  const [cards, odds, packRows] = await Promise.all([
    handles.length
      ? packs.listCards({ handle: handles }, { take: handles.length })
      : Promise.resolve([]),
    handles.length
      ? packs.listPackOdds(
          { card_id: handles, pack_id: slugs },
          { take: handles.length * slugs.length },
        )
      : Promise.resolve([]),
    slugs.length
      ? packs.listPacks({ slug: slugs }, { take: slugs.length })
      : Promise.resolve([]),
  ]);
  const byHandle = cardByHandle(cards);
  const rarityOf = makeRarityOf(
    odds.filter((o): o is typeof o & { card_id: string } => o.card_id != null),
  );
  const packBySlug = new Map(packRows.map((p) => [p.slug, p]));
  return shown.map((r, i) => {
    const card = byHandle.get(r.card_id);
    const pack = packBySlug.get(r.pack_id);
    const who = pullers.profileOf(r.customer_id, r.id);
    return {
      rank: i + 1,
      pull_id: r.id,
      pulled_at: new Date(r.rolled_at).toISOString(),
      card: {
        handle: r.card_id,
        name: card?.name ?? r.card_id,
        grade: [card?.grader, card?.grade].filter((s) => s?.trim()).join(' '),
        grader: card?.grader ?? '',
        set: card?.set ?? '',
        rarity: rarityOf(r.pack_id, r.card_id),
        image: card?.image ?? null,
        slab_image: card?.slab_image ?? null,
      },
      pack: {
        slug: r.pack_id,
        title: pack?.title ?? null,
        image: pack?.image ?? null,
      },
      value_myr: r.value_myr,
      player: {
        // A link in a name is still an ad, even in a picture.
        name: stripAutolinks(who.who) || 'Anonymous',
        handle: who.profile_handle,
      },
      customer_id: r.customer_id,
    };
  });
}

/** The public view of a top pull: no customer id. */
export const publicTopPull = ({ customer_id: _id, ...pull }: TopPull) => pull;

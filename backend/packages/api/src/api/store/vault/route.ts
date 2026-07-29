import {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import PacksModuleService from '../../../modules/packs/service';
import { PACKS_MODULE } from '../../../modules/packs';
import {
  buybackAmount,
  resolveBuybackRate,
} from '../../../modules/packs/buyback-rate';
import {
  cardByHandle,
  makeRarityOf,
  toCardView,
} from '../../../modules/packs/card-view';
import { toMoney } from '../../../modules/packs/money';
import {
  DEFAULT_MARKET_MULTIPLIER,
  displayMarketPrice,
  resolveFxRateInfo,
} from '../../../modules/packs/pricing';

// GET /store/vault — the authenticated customer's vault: every pull still held
// (status "vaulted"), newest first, with a LIVE buyback offer per item: current
// FMV × the rate that would apply RIGHT NOW (instant inside the post-pull
// window, the flat rate after — resolveBuybackRate, the same logic the
// buyback workflow runs, so the quote always matches the credit).
//
// Reward Pulls (source='reward') are included here — they are rendered from
// the matching reward_draw.prize_snapshot (keyed by vault_pull_id) rather than
// a Card row. No buyback block is emitted for reward prizes (they can't be sold
// back — see the C1 guard in buyback-pull.ts).
//
// AUTH: matcher registered in src/api/middlewares.ts with authenticate(); the
// customer id comes ONLY from the verified token, so a caller can never read
// another customer's vault.
const VAULT_LIMIT = 500;

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const packs: PacksModuleService = req.scope.resolve(PACKS_MODULE);
  const customerId = req.auth_context.actor_id;
  const { rate: fxRate, firm: fxFirm } = await resolveFxRateInfo(packs);

  const pulls = await packs.listPulls(
    { customer_id: customerId, status: 'vaulted' },
    { order: { rolled_at: 'DESC' }, take: VAULT_LIMIT },
  );

  // Separate reward pulls (rendered from prize_snapshot) from normal card pulls.
  const normalPulls = pulls.filter((p) => p.source !== 'reward');
  const rewardPulls = pulls.filter((p) => p.source === 'reward');

  // For normal card pulls: resolve cards, packs, and odds as before.
  const handles = [...new Set(normalPulls.map((p) => p.card_id))];
  const normalPackIds = [...new Set(normalPulls.map((p) => p.pack_id))];

  const [cards, packRows, oddsRows] = await Promise.all([
    handles.length
      ? packs.listCards({ handle: handles }, { take: handles.length })
      : Promise.resolve([]),
    normalPackIds.length
      ? packs.listPacks({ slug: normalPackIds }, { take: normalPackIds.length })
      : Promise.resolve([]),
    handles.length
      ? packs.listPackOdds({ card_id: handles }, { take: 1000 })
      : Promise.resolve([]),
  ]);

  const byHandle = cardByHandle(cards);
  const packBySlug = new Map(packRows.map((p) => [p.slug, p]));
  // Reward rows (card_id null) carry no card rarity — exclude before the lookup.
  const cardOdds = oddsRows.filter(
    (o): o is typeof o & { card_id: string } => o.card_id != null,
  );
  const rarityOf = makeRarityOf(cardOdds);

  // For reward pulls: load matching reward_draw rows keyed by vault_pull_id.
  // ponytail: single batch query; vault is capped at 500 so N is bounded.
  const rewardPullIds = rewardPulls.map((p) => p.id);
  const rewardDrawRows = rewardPullIds.length
    ? await packs.listRewardDraws(
        { vault_pull_id: rewardPullIds },
        { take: rewardPullIds.length },
      )
    : [];
  const drawByPullId = new Map(rewardDrawRows.map((d) => [d.vault_pull_id, d]));

  // Build vault items — normal pulls first (existing shape), then reward pulls.
  const normalItems = normalPulls
    .map((p) => {
      const card = byHandle.get(p.card_id);
      if (!card) return null;
      const marketValue = toMoney(card.market_value);
      if (!Number.isFinite(marketValue)) return null;
      const pack = packBySlug.get(p.pack_id);
      const { percent, rate_type } = resolveBuybackRate(pack, {
        rolled_at: p.rolled_at,
        revealed_at: p.revealed_at,
        // Reaching the vault means the reveal was left, so the window is closed
        // and this always quotes the flat rate (the stamp is set on leave; the
        // 30s timer is only the hard-tab-kill backstop).
        instant_closed_at: p.instant_closed_at,
      });
      // MYR Value (raw USD × FX × markup) — the buyback percent is a cut of this
      // shown Value, not raw USD, matching what selling actually credits.
      const marketPriceMyr = displayMarketPrice(
        marketValue,
        fxRate,
        Number(card.market_multiplier ?? DEFAULT_MARKET_MULTIPLIER),
      );
      return {
        pull_id: p.id,
        rolled_at: p.rolled_at,
        pack_id: p.pack_id,
        pack_title: pack?.title ?? p.pack_id,
        showcased: (p as unknown as { showcased: boolean }).showcased ?? false,
        card: {
          ...toCardView(card, rarityOf(p.pack_id, p.card_id)),
          marketPriceMyr,
        },
        buyback: {
          percent,
          amount: buybackAmount(marketPriceMyr, percent),
          rate_type,
          // false when amount was computed on the display FX fallback — the
          // sell would refuse, so the UI must not present it as a firm offer
          // (sim finding P1-1).
          firm: fxFirm,
        },
      };
    })
    .filter((e): e is NonNullable<typeof e> => e !== null);

  // Reward pull items: title/image from prize_snapshot; no buyback block.
  // If the reward_draw row is missing (a partial write or orphaned snapshot),
  // STILL show the pull — it is an owned vault item — as a degraded placeholder
  // rather than silently dropping the customer's prize from their vault.
  const rewardItems = rewardPulls.map((p) => {
    const draw = drawByPullId.get(p.id);
    const snap = (draw?.prize_snapshot ?? {}) as {
      title?: string;
      image?: string;
      product_handle?: string;
    };
    return {
      pull_id: p.id,
      rolled_at: p.rolled_at,
      pack_id: p.pack_id,
      title: snap.title ?? 'Reward prize',
      image: snap.image ?? '',
      source: 'reward' as const,
    };
  });

  // Merge in rolled_at DESC order (pulls was already ordered DESC; preserve).
  const items = [...normalItems, ...rewardItems].sort(
    (a, b) => new Date(b.rolled_at).getTime() - new Date(a.rolled_at).getTime(),
  );

  res.json({ items });
}

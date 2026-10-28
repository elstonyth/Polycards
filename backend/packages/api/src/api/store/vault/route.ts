import {
  bonusShareMyr,
  sellbackHoldBp,
} from '../../../modules/packs/bonus-credit';
import {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import PacksModuleService from '../../../modules/packs/service';
import { PACKS_MODULE } from '../../../modules/packs';
import {
  UNQUOTED_BUYBACK,
  buybackAmount,
  resolveBuybackRate,
  revealGraceMs,
} from '../../../modules/packs/buyback-rate';
import { withLossless } from '../../../modules/packs/lossless';
import { isChallengePrizePack } from '../../../modules/packs/challenge-prize';
import { isLuckyDrawPrizePack } from '../../../modules/packs/lucky-draw';
import { pullPackTitle } from '../../../modules/packs/pull-history';
import { bestLiveTierByHandle } from '../../../modules/packs/card-tier';
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
// Every item carries `source` and `locked`. `locked` is true ONLY for the free
// welcome pull and a DAILY task's card, before the customer's first PAID open
// (lockedPullIds, resolved once per request): they can be neither sold nor
// delivered until then, so they carry NO sellable quote — see the buyback block
// below.
//
// Every other reward pull (source='reward' — weekly-challenge prizes, weekly
// and achievement task rewards) is included here with a live quote like any
// other card: it sells (completing the task is the requirement) and ships via
// the reward withdraw path.
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
  // The pulls are read next to the FX read so they cost no extra round trip.
  // Same for the Lossless windows: a pull still inside its instant window was
  // rolled within the reveal grace, so nothing that ended before that can lift
  // a quote here.
  const [{ rate: fxRate, firm: fxFirm }, windows, pulls] = await Promise.all([
    resolveFxRateInfo(packs),
    packs.losslessWindows(Date.now() - revealGraceMs()),
    packs.listPulls(
      { customer_id: customerId, status: 'vaulted' },
      { order: { rolled_at: 'DESC' }, take: VAULT_LIMIT },
    ),
  ]);

  // EVERY pull now takes the card path. The old second branch rendered a pull
  // from its reward_draw prize_snapshot, which existed because a daily-box
  // prize could be a bare product handle with no Card row behind it. The daily
  // box was removed 2026-08-25 and reward_draw with it, so every surviving
  // source='reward' pull — weekly-challenge prizes and task rewards alike —
  // carries a real card handle and belongs here, where it sells and showcases
  // like any pulled card. (Challenge prizes were moved across first, for
  // exactly this reason: on the reward branch they emitted no card/buyback and
  // the storefront's VaultItemSchema dropped them outright, so a won card
  // rendered as NOTHING in the winner's vault.)
  const normalPulls = pulls;
  const handles = [...new Set(normalPulls.map((p) => p.card_id))];
  const normalPackIds = [...new Set(normalPulls.map((p) => p.pack_id))];

  // ONE lock read for the whole list (the unlock is computed, never stored —
  // see lockedPullIds), next to the card reads.
  const [cards, packRows, oddsRows, lockedIds] = await Promise.all([
    handles.length
      ? packs.listCards({ handle: handles }, { take: handles.length })
      : Promise.resolve([]),
    normalPackIds.length
      ? packs.listPacks({ slug: normalPackIds }, { take: normalPackIds.length })
      : Promise.resolve([]),
    handles.length
      ? packs.listPackOdds({ card_id: handles }, { take: 1000 })
      : Promise.resolve([]),
    packs.lockedPullIds(customerId, normalPulls),
  ]);

  const byHandle = cardByHandle(cards);
  const packBySlug = new Map(packRows.map((p) => [p.slug, p]));
  // Reward rows (card_id null) carry no card rarity — exclude before the lookup.
  const cardOdds = oddsRows.filter(
    (o): o is typeof o & { card_id: string } => o.card_id != null,
  );
  const rarityOf = makeRarityOf(cardOdds);

  // A challenge prize's synthetic pack has no odds rows, so makeRarityOf would
  // fall back to 'Common' and paint an Immortal card with the Common chip —
  // the exact wrong-tier report this work started from. Resolve those the same
  // way the card page does (best tier among openable packs), from ONE batched
  // lookup, and only when the customer actually holds a prize.
  // Every source='reward' pull rides a synthetic pack with no odds rows —
  // challenge prizes on challengePackId(week), task card rewards on the
  // 'task-reward' sentinel — so all of them need the same treatment, not just
  // the challenge ones. A pack-reward (a task's free rip) names a REAL pack and
  // is not in here: its odds rows resolve the tier normally.
  const isSyntheticReward = (p: { source?: string | null; pack_id: string }) =>
    p.source === 'reward' && !packBySlug.has(p.pack_id);
  // A Lucky Draw card takes no tier at all (below), so it needs no lookup.
  const prizeHandles = normalPulls
    .filter((p) => isSyntheticReward(p) && !isLuckyDrawPrizePack(p.pack_id))
    .map((p) => p.card_id);
  const prizeTier = await bestLiveTierByHandle(packs, prizeHandles);

  // Build vault items — normal pulls first (existing shape), then reward pulls.
  const normalItems = normalPulls
    .map((p) => {
      const card = byHandle.get(p.card_id);
      if (!card) return null;
      const marketValue = toMoney(card.market_value);
      if (!Number.isFinite(marketValue)) return null;
      const pack = packBySlug.get(p.pack_id);
      const prize = isChallengePrizePack(p.pack_id);
      const luckyDraw = isLuckyDrawPrizePack(p.pack_id);
      // The free welcome pull and a daily task's card are unsellable until
      // the customer's first PAID open — the SAME rule buyback-pull.ts
      // refuses on. `locked` = neither sellable NOR shippable.
      const locked = lockedIds.has(p.id);
      // `sellable` used to be narrower than `!locked` — buyback-pull.ts refused
      // every source='reward' pull that was not a challenge prize, so a task
      // reward quoted RM 0.00 in the vault forever. That refusal is gone (task
      // and achievement rewards sell like any pulled card — completing the
      // task is the requirement), so the two facts coincide. The field stays:
      // the storefront keys its Sell affordance off it.
      const sellable = !locked;
      // Lossless Mode at rolled_at, as the credit decides it (buyback-pull.ts).
      const priced = withLossless(
        pack,
        windows,
        new Date(p.rolled_at).getTime(),
        p.source,
      );
      const { percent, rate_type } = resolveBuybackRate(priced, {
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
        // The synthetic `challenge-<week>` id is not a pack title anyone should
        // read; name the surface it was won on instead.
        pack_title: pullPackTitle(p, pack?.title),
        // A weekly-challenge prize keeps the challenge's own prism frame in the
        // vault instead of taking the card's pack tier — it was won there, not
        // pulled from a pack. Stated by the backend rather than left to the
        // storefront to infer from the synthetic pack id.
        challenge_prize: prize,
        // A Lucky Draw card wears no tier frame and states no tier: won, not
        // pulled, and the bare slab is how the vault says so.
        lucky_draw_prize: luckyDraw,
        showcased: (p as unknown as { showcased: boolean }).showcased ?? false,
        card: {
          // A synthetic pack has no odds row, so rarityOf would answer
          // 'Common' for it — the exact wrong-tier report this work started
          // from. Keyed off isSyntheticReward, NOT `prize`: a task reward has
          // the same no-odds shape as a challenge prize and needs the same
          // resolved live tier.
          ...toCardView(
            card,
            luckyDraw
              ? ''
              : isSyntheticReward(p)
                ? (prizeTier.get(p.card_id) ?? '')
                : rarityOf(p.pack_id, p.card_id),
          ),
          marketPriceMyr,
          // The linked sprite (Pokémon or One Piece), so the vault never has
          // to guess one from the card name ("Bartholomew Kuma" → Mew).
          pokemon_dex: card.pokemon_dex ?? null,
          sprite_image: card.sprite_image ?? null,
        },
        // How the pull was acquired. NOTE for UI code: a weekly-challenge prize
        // takes THIS path with source='reward' and a live, sellable quote — so
        // the sell/deliver lock must be keyed off `locked`, NEVER off `source`.
        source: p.source ?? 'pack',
        locked,
        // Share of the pull's price paid as bonus or promo (spec 2026-10-07):
        // 10000 on a gift, the bonus share on a bonus open. What of a sale is
        // held is buyback.bonus (a reward's or gift's: none, ADR 0012).
        bonus_bp: Number(p.bonus_bp ?? 0),
        // Can this row be SOLD? Now exactly `!locked` — a reward card sells
        // like any other (and still ships via the reward path). Kept as its
        // own field: the storefront's Sell affordance keys off it.
        sellable,
        // A LOCKED pull must advertise NOTHING payable: selling it 400s
        // (FREE_PULL_LOCKED_MESSAGE), so quoting a price here would offer
        // the customer money the sell then refuses. UNQUOTED_BUYBACK is the same
        // "no quote" block the open route degrades to — deliberately NOT an
        // omitted/null field, because the storefront drops any vault row
        // without a finite buyback.percent, which would delete the customer's
        // free card from their own vault.
        //
        // `firm` is OVERRIDDEN back to the real FX firmness — it must NOT be
        // UNQUOTED_BUYBACK's false. `firm` means "the FX rate is firm", which
        // is a GLOBAL fact, and FX is firm for a locked pull like any other.
        // The vault aggregates it globally (`items.every(i => i.buyback.firm)`
        // in VaultClient.tsx), so a hardcoded false on ONE locked row would
        // blame the lock on a pricing outage for the WHOLE vault and block the
        // customer from selling their other, genuinely sellable cards.
        // The lock is carried by `locked`, never by `firm`.
        buyback: !sellable
          ? { ...UNQUOTED_BUYBACK, firm: fxFirm }
          : {
              percent,
              amount: buybackAmount(marketPriceMyr, percent),
              // The part of that amount from bonus or welcome-pack play,
              // which must be played through before it can be withdrawn.
              // None for a reward or a gift (ADR 0012).
              bonus: bonusShareMyr(
                buybackAmount(marketPriceMyr, percent),
                sellbackHoldBp(p),
              ),
              rate_type,
              // false when amount was computed on the display FX fallback — the
              // sell would refuse, so the UI must not present it as a firm offer
              // (sim finding P1-1).
              firm: fxFirm,
            },
      };
    })
    .filter((e): e is NonNullable<typeof e> => e !== null);

  // Already rolled_at DESC from listPulls; the sort keeps that explicit now
  // that a single list feeds it.
  const items = [...normalItems].sort(
    (a, b) => new Date(b.rolled_at).getTime() - new Date(a.rolled_at).getTime(),
  );

  res.json({ items });
}

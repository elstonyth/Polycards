import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import {
  ContainerRegistrationKeys,
  MedusaError,
} from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../../../../modules/packs';
import type PacksModuleService from '../../../../../../modules/packs/service';
import { takeCardStock } from '../../../../../../modules/packs/card-stock';
import { rollOne } from '../../../../../../workflows/steps/roll-pack';
import { resolveOddsSetForCustomer } from '../../../../../../modules/packs/odds-sets';
import { toMoney } from '../../../../../../modules/packs/money';
import {
  FLAT_PERCENT,
  UNQUOTED_BUYBACK,
  buybackAmount,
  instantDeadlineMs,
} from '../../../../../../modules/packs/buyback-rate';
import {
  DEFAULT_MARKET_MULTIPLIER,
  displayMarketPrice,
  resolveFxRateInfo,
} from '../../../../../../modules/packs/pricing';

// POST /store/tasks/claims/:claimId/spin — spend a task's free-rip entitlement.
//
// The slot's Spin button calls this instead of the paid open route. Claiming a
// pack reward does NOT roll; it records an entitlement, and this is where the
// player actually rips it. The roll, the pull and the entitlement's stamp all
// commit in ONE transaction (redeemTaskPackClaim), so closing the tab mid-spin
// either leaves the entitlement untouched or leaves the card in the vault —
// never nothing.
//
// AUTH + RATE LIMIT are registered in api/middlewares.ts. The customer id comes
// ONLY from the verified bearer token, and the claim's ownership is re-checked
// inside the service — the claim id is client-supplied.
//
// The response mirrors POST /store/packs/:slug/open closely enough that the
// storefront reuses one reveal path. `price` is 0 (nothing was charged), and
// the card is sellable on the spot: a task reward sells like any pulled card
// (completing the task IS the requirement — no free-welcome lock applies), so
// the reveal gets the same authoritative instant quote a paid open gets.
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const customerId = req.auth_context?.actor_id;
  if (!customerId) {
    throw new MedusaError(MedusaError.Types.UNAUTHORIZED, 'Unauthorized');
  }
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);

  const result = await packs.redeemTaskPackClaim({
    customerId,
    claimId: req.params.claimId,
    decrementStock: takeCardStock(req.scope),
    rollPack: async (packId) => {
      // Same odds-set resolution as a paid open — a free rip is still THIS
      // customer's rip, on this customer's odds.
      const set = await resolveOddsSetForCustomer(req.scope, customerId);
      return rollOne(packs, packId, set);
    },
  });

  if (!result.redeemed) {
    res.json(result);
    return;
  }

  // ⚠ POST-COMMIT from here down. The pull exists and the entitlement is spent;
  // nothing below can undo that, so a failure must degrade rather than throw —
  // the player has the card either way, and an error page would read as a lost
  // free rip. Same stance as the open route's enrichment block: the card
  // drops marketPriceMyr and the quote degrades to UNQUOTED_BUYBACK (firm:
  // false), so the reveal never presents a number the sell would not honour.
  let card: Record<string, unknown> = result.card;
  // The open route's reveal quote shape, so a dropped field fails tsc rather
  // than silently reaching the storefront as undefined.
  let buyback: {
    percent: number;
    amount: number;
    firm: boolean;
    vault_percent: number;
    vault_amount: number;
    rate_type?: string;
    instant_deadline_ms?: number;
  } = { ...UNQUOTED_BUYBACK };
  try {
    const [{ rate: fxRate, firm: fxFirm }, [row]] = await Promise.all([
      resolveFxRateInfo(packs),
      packs.listCards(
        { handle: result.card.handle },
        { select: ['handle', 'market_multiplier'], take: 1 },
      ),
    ]);
    // MYR display Value (raw USD × FX × per-card markup) — what the reveal
    // shows, and the base the buyback percent applies to.
    const marketPriceMyr = displayMarketPrice(
      toMoney(result.card.market_value),
      fxRate,
      Number(row?.market_multiplier ?? DEFAULT_MARKET_MULTIPLIER),
    );
    card = { ...result.card, marketPriceMyr };
    // Quote from the SAME helper the buyback workflow credits with, so the
    // reveal's "sell on the spot" number is what selling pays. Freshly rolled,
    // so this is inside the instant window.
    const quoted = await packs.quoteBuyback(
      result.packId,
      {
        rolled_at: result.rolledAt,
        revealed_at: null,
        instant_closed_at: null,
      },
      marketPriceMyr,
    );
    buyback = {
      ...quoted,
      firm: fxFirm,
      vault_percent: FLAT_PERCENT,
      vault_amount: buybackAmount(marketPriceMyr, FLAT_PERCENT),
      instant_deadline_ms: instantDeadlineMs(result.rolledAt, null),
    };
  } catch (err) {
    req.scope
      .resolve(ContainerRegistrationKeys.LOGGER)
      .error(
        `[task-spin] post-commit enrichment failed for claim '${req.params.claimId}' (customer ${customerId}) — serving the pull with a degraded card and quote`,
        err instanceof Error ? err : new Error(String(err)),
      );
  }

  res.json({
    ...result,
    pull: { id: result.pullId },
    card,
    // Free by definition, so no charge and no balance change.
    price: 0,
    balance: null,
    free: true,
    // Never locked: the free-welcome lock is keyed on source='free', and a
    // task reward is source='reward'. Sellable AND shippable (the latter via
    // the reward withdraw path) — same as GET /store/vault reports it.
    locked: false,
    sellable: true,
    buyback,
  });
}

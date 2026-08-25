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
import { UNQUOTED_BUYBACK } from '../../../../../../modules/packs/buyback-rate';
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
// storefront reuses one reveal path, with two deliberate differences: `price`
// is 0 and nothing is quoted for sell-back, because a reward pull is not
// sellable (see `sellable`).
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
  // free rip. Same stance as the open route's enrichment block.
  //
  // The rolled card already carries everything the reveal needs EXCEPT the MYR
  // display price, which needs the live FX rate.
  let card: Record<string, unknown> = result.card;
  try {
    const { rate: fxRate } = await resolveFxRateInfo(packs);
    const [row] = await packs.listCards(
      { handle: result.card.handle },
      { select: ['handle', 'market_multiplier'], take: 1 },
    );
    card = {
      ...result.card,
      marketPriceMyr: displayMarketPrice(
        toMoney(result.card.market_value),
        fxRate,
        Number(row?.market_multiplier ?? DEFAULT_MARKET_MULTIPLIER),
      ),
    };
  } catch (err) {
    req.scope
      .resolve(ContainerRegistrationKeys.LOGGER)
      .error(
        `[task-spin] post-commit enrichment failed for claim '${req.params.claimId}' (customer ${customerId}) — serving the pull with a degraded card`,
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
    // NOT locked: a reward card ships (recordRewardWithdrawal). It is simply
    // never sellable, which is what suppresses the reveal's sell offer — the
    // same split GET /store/vault makes.
    locked: false,
    sellable: false,
    buyback: UNQUOTED_BUYBACK,
  });
}

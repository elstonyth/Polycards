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
// the card is sellable on the spot: a weekly or achievement task reward sells
// like any pulled card (completing the task IS the requirement), so the reveal
// gets the same authoritative instant quote a paid open gets. A DAILY task's
// free rip is the exception (owner, 2026-10-23): until the customer's first
// PAID open it carries the free welcome pull's lock (lockedPullIds), so it
// answers `locked: true` with no quote, exactly like a locked free open.
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const customerId = req.auth_context?.actor_id;
  if (!customerId) {
    throw new MedusaError(MedusaError.Types.UNAUTHORIZED, 'Unauthorized');
  }
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);

  // Roll BEFORE the claim's lock. The roll reads odds and the customer's group
  // on connections of their own, which must not be taken while the lock and
  // its connection are held. A roll has no side effects, so one a spent claim never uses is
  // dropped. The service still decides, under the lock. A spun claim is not
  // rolled at all: its retry must get its pull back even if the pack is off.
  const [peek] = await packs.listTaskClaims(
    { id: req.params.claimId, customer_id: customerId },
    { take: 1 },
  );
  const snapshot = (peek?.reward_snapshot ?? {}) as {
    type?: string;
    pack_id?: string;
  };
  const preRolled =
    !peek?.claim_ref &&
    snapshot.type === 'pack' &&
    typeof snapshot.pack_id === 'string'
      ? // Same odds-set resolution as a paid open — a free rip is still THIS
        // customer's rip, on this customer's odds.
        await rollOne(
          packs,
          snapshot.pack_id,
          await resolveOddsSetForCustomer(req.scope, customerId),
        )
      : null;
  const result = await packs.redeemTaskPackClaim({
    customerId,
    claimId: req.params.claimId,
    rollPack: async (packId) => {
      if (!preRolled || packId !== snapshot.pack_id) {
        throw new MedusaError(
          MedusaError.Types.UNEXPECTED_STATE,
          'This free rip changed while spinning. Try again.',
        );
      }
      return preRolled;
    },
  });

  if (!result.redeemed) {
    res.json(result);
    return;
  }

  // The stock take runs AFTER the redeem committed, as the task claim route
  // does: the inventory module writes on its own connection. A counter, never
  // a gate: a failed take leaves it reading high, and the card is vaulted.
  let taken = false;
  try {
    taken = await takeCardStock(req.scope)(result.card.handle, 1);
    // Earmarked, so a later sell-back puts the unit back.
    if (taken) {
      await packs.updatePulls([{ id: result.pullId, stock_earmarked: true }]);
    }
  } catch (error) {
    req.scope
      .resolve(ContainerRegistrationKeys.LOGGER)
      .warn(
        `[task-spin] ${taken ? 'earmark' : 'stock take'} for '${result.card.handle}' failed AFTER claim '${req.params.claimId}' redeemed — ${taken ? 'a sell-back will not restore its unit' : 'counter reads high'}, card already vaulted: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
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
  // A daily task's rip carries the free welcome pull's lock until the first
  // PAID open. Its own try, failing CLOSED: a lookup error must not let the
  // reveal offer a sell the buyback step then refuses (the vault shows the
  // real answer on the next read), nor cost the card its price enrichment.
  let locked = true;
  try {
    locked = (
      await packs.lockedPullIds(customerId, [
        { id: result.pullId, source: 'reward' },
      ])
    ).has(result.pullId);
  } catch (err) {
    req.scope
      .resolve(ContainerRegistrationKeys.LOGGER)
      .error(
        `[task-spin] lock lookup failed for claim '${req.params.claimId}' (customer ${customerId}) — serving the pull as locked`,
        err instanceof Error ? err : new Error(String(err)),
      );
  }
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
    // A locked rip offers no sell-on-the-spot price — selling it 400s — so
    // UNQUOTED_BUYBACK stays, as on a locked free open. marketPriceMyr above
    // still shows what the card is worth.
    if (!locked) {
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
        undefined,
        // A free rip is a source='reward' pull on a real pack: Lossless Mode
        // never lifts it, and the quote must say so to match the credit.
        'reward',
      );
      buyback = {
        ...quoted,
        firm: fxFirm,
        vault_percent: FLAT_PERCENT,
        vault_amount: buybackAmount(marketPriceMyr, FLAT_PERCENT),
        instant_deadline_ms: instantDeadlineMs(result.rolledAt, null),
      };
    }
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
    // Same answer GET /store/vault gives: locked only for a daily task's rip
    // before the first PAID open; otherwise sellable AND shippable (the latter
    // via the reward withdraw path).
    locked,
    sellable: !locked,
    buyback,
  });
}

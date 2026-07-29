import {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { ContainerRegistrationKeys } from '@medusajs/framework/utils';
import { openPackWorkflow } from '../../../../../workflows/open-pack';
import { PACKS_MODULE } from '../../../../../modules/packs';
import type PacksModuleService from '../../../../../modules/packs/service';
import { toMoney } from '../../../../../modules/packs/money';
import {
  FLAT_PERCENT,
  UNQUOTED_BUYBACK,
  buybackAmount,
  instantDeadlineMs,
} from '../../../../../modules/packs/buyback-rate';
import {
  DEFAULT_MARKET_MULTIPLIER,
  displayMarketPrice,
  resolveFxRateInfo,
} from '../../../../../modules/packs/pricing';

// POST /store/packs/:slug/open — open a pack: roll a winner over the pack's
// weighted odds and append the result to the Pull ledger.
//
// AUTH: this matcher is registered in src/api/middlewares.ts with
// authenticate("customer", ["bearer"]) (bearer-only — customer session cookies
// don't exist on this backend), so the request is guaranteed authenticated by
// the time it reaches here. The customer id is taken ONLY from
// the verified token (req.auth_context.actor_id) — never from the body/param —
// so a caller cannot forge pulls for another account. AuthenticatedMedusaRequest
// makes actor_id non-optional (the authenticate middleware guarantees it).
//
// Business validation (pack active, odds present) lives in the workflow steps,
// not here; a MedusaError thrown there is mapped to its HTTP status (e.g. an
// unknown/inactive slug → 404) by Medusa's error handler.
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const customerId = req.auth_context.actor_id;
  const { slug } = req.params;

  const { result } = await openPackWorkflow(req.scope).run({
    input: { pack_id: slug, customer_id: customerId },
  });

  const packsService = req.scope.resolve<PacksModuleService>(PACKS_MODULE);

  // ⚠ EVERYTHING BELOW IS POST-COMMIT — the workflow has ALREADY debited the
  // customer and written the pull row, and nothing here can roll that back. So
  // a failure below must NOT fail the request: the player paid and the card IS
  // in their vault, and throwing would show them a generic error instead of
  // their reveal — reading as a lost charge. Degrade instead, and log loudly (a
  // silent catch would hide a systemic quoting outage behind "every buyback is
  // degraded"). The card drops marketPriceMyr, which the storefront renders as
  // '—' rather than showing raw USD behind "RM"; the quote degrades to
  // UNQUOTED_BUYBACK (firm: false — see its comment for why NOT null).
  let card;
  let buyback;
  try {
    const marketValue = toMoney(result.card.market_value);

    // Live MYR Value (raw USD x FX x per-card multiplier) — the number the reveal
    // card shows and the base the buyback percent applies to (buyback pays MYR
    // credits, so it must be a cut of the shown Value, not raw USD). market_value
    // itself stays the raw USD decimal untouched. RolledCard (the roll-pack step's
    // normalized winner shape) does not carry market_multiplier, so it is looked up
    // here by handle — same field the vault route reads.
    const { rate: fxRate, firm: fxFirm } =
      await resolveFxRateInfo(packsService);
    const [wonCardRow] = await packsService.listCards(
      { handle: result.card.handle },
      { take: 1 },
    );
    const marketPriceMyr = displayMarketPrice(
      marketValue,
      fxRate,
      Number(wonCardRow?.market_multiplier ?? DEFAULT_MARKET_MULTIPLIER),
    );

    // Quote the instant sell-back from the SAME helper the buyback workflow credits
    // with (quoteBuyback wraps resolveBuybackRate + buybackAmount) — off the MYR
    // Value — so the reveal's "sell on the spot" number is authoritative and can
    // never disagree with what selling actually credits. The storefront must NOT
    // recompute this. Freshly rolled, so this is inside the instant window.
    const quoted = await packsService.quoteBuyback(
      slug,
      {
        rolled_at: result.pull.rolled_at,
        revealed_at: result.pull.revealed_at,
        instant_closed_at: result.pull.instant_closed_at,
      },
      marketPriceMyr,
    );

    card = { ...result.card, marketPriceMyr };
    buyback = {
      ...quoted,
      // false when the MYR amounts were computed on the display FX fallback:
      // the sell would be refused ("Exchange rate unavailable"), so the UI
      // must not present this quote as a firm offer (sim finding P1-1).
      firm: fxFirm,
      // The flat rate that applies after the instant window — surfaced so the
      // reveal can offer a post-expiry "sell at flat" without recomputing.
      vault_percent: FLAT_PERCENT,
      vault_amount: buybackAmount(marketPriceMyr, FLAT_PERCENT),
      // Fallback instant deadline (rolled_at + window) for when the reveal ping
      // fails; the ping returns the authoritative, reveal-anchored deadline.
      instant_deadline_ms: instantDeadlineMs(
        result.pull.rolled_at,
        result.pull.revealed_at,
      ),
    };
  } catch (err) {
    req.scope
      .resolve(ContainerRegistrationKeys.LOGGER)
      .error(
        `[open] post-commit enrichment failed for '${slug}' (customer ${customerId}) — serving the PAID pull with a degraded buyback`,
        err instanceof Error ? err : new Error(String(err)),
      );
    card = result.card;
    buyback = UNQUOTED_BUYBACK;
  }

  // result.card is already a plain, JSON-safe object (normalized in roll-pack);
  // market_value is a USD decimal, never cents. balance is the post-charge
  // credit balance (Task A2 — opens debit the pack price from the ledger).
  res.json({
    pull: result.pull,
    card,
    balance: result.balance,
    price: result.price,
    buyback,
  });
}

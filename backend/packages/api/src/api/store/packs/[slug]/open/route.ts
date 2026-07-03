import {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { openPackWorkflow } from '../../../../../workflows/open-pack';
import { PACKS_MODULE } from '../../../../../modules/packs';
import type PacksModuleService from '../../../../../modules/packs/service';
import { toMoney } from '../../../../../modules/packs/money';
import {
  FLAT_PERCENT,
  buybackAmount,
  instantDeadlineMs,
} from '../../../../../modules/packs/buyback-rate';
import { displayMarketPrice, resolveFxRate } from '../../../../../modules/packs/pricing';

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
  const marketValue = toMoney(result.card.market_value);

  // Live MYR Value (raw USD x FX x per-card multiplier) — the number the reveal
  // card shows and the base the buyback percent applies to (buyback pays MYR
  // credits, so it must be a cut of the shown Value, not raw USD). market_value
  // itself stays the raw USD decimal untouched. RolledCard (the roll-pack step's
  // normalized winner shape) does not carry market_multiplier, so it is looked up
  // here by handle — same field the vault route reads.
  const fxRate = await resolveFxRate(packsService);
  const [wonCardRow] = await packsService.listCards(
    { handle: result.card.handle },
    { take: 1 },
  );
  const marketPriceMyr = displayMarketPrice(
    marketValue,
    fxRate,
    Number(wonCardRow?.market_multiplier ?? 1.2),
  );

  // Quote the instant sell-back from the SAME helper the buyback workflow credits
  // with (quoteBuyback wraps resolveBuybackRate + buybackAmount) — off the MYR
  // Value — so the reveal's "sell on the spot" number is authoritative and can
  // never disagree with what selling actually credits. The storefront must NOT
  // recompute this. Freshly rolled, so this is inside the instant window.
  const buyback = await packsService.quoteBuyback(
    slug,
    { rolled_at: result.pull.rolled_at, revealed_at: result.pull.revealed_at },
    marketPriceMyr,
  );

  // result.card is already a plain, JSON-safe object (normalized in roll-pack);
  // market_value is a USD decimal, never cents. balance is the post-charge
  // credit balance (Task A2 — opens debit the pack price from the ledger).
  res.json({
    pull: result.pull,
    card: { ...result.card, marketPriceMyr },
    balance: result.balance,
    price: result.price,
    buyback: {
      ...buyback,
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
    },
  });
}

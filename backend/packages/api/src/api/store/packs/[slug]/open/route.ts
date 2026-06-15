import {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { openPackWorkflow } from '../../../../../workflows/open-pack';
import { PACKS_MODULE } from '../../../../../modules/packs';
import type PacksModuleService from '../../../../../modules/packs/service';
import { toMoney } from '../../../../../modules/packs/money';

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

  // Quote the instant sell-back offer for THIS pull from the SAME helper the
  // buyback workflow credits with (packsService.quoteBuyback wraps
  // resolveBuybackRate + buybackAmount), so the reveal's "sell on the spot"
  // number is authoritative and can never disagree with what selling actually
  // credits. The storefront must NOT recompute this from its own pack catalog —
  // that value drifts from the DB on a mock-catalog fallback, a stale page, or a
  // sibling-pack switch, which is how the reveal ended up quoting the flat 90%
  // on a 99%-boosted pack. Freshly rolled, so this is inside the instant window
  // (rate_type "instant").
  const packsService = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const buyback = await packsService.quoteBuyback(
    slug,
    result.pull.rolled_at,
    toMoney(result.card.market_value),
  );

  // result.card is already a plain, JSON-safe object (normalized in roll-pack);
  // market_value is a USD decimal, never cents. balance is the post-charge
  // credit balance (Task A2 — opens debit the pack price from the ledger).
  res.json({
    pull: result.pull,
    card: result.card,
    balance: result.balance,
    price: result.price,
    buyback,
  });
}

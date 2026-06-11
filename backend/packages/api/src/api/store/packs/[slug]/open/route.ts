import {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import { openPackWorkflow } from "../../../../../workflows/open-pack";

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
  res: MedusaResponse
): Promise<void> {
  const customerId = req.auth_context.actor_id;
  const { slug } = req.params;

  const { result } = await openPackWorkflow(req.scope).run({
    input: { pack_id: slug, customer_id: customerId },
  });

  // result.card is already a plain, JSON-safe object (normalized in roll-pack);
  // market_value is a USD decimal, never cents.
  res.json({ pull: result.pull, card: result.card });
}

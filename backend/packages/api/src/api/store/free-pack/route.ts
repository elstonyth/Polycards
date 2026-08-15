import {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { PACKS_MODULE } from '../../../modules/packs';
import type PacksModuleService from '../../../modules/packs/service';

// GET /store/free-pack — feeds the storefront's floating FREE PACK badge.
//
// eligible = stamped at registration AND not yet claimed AND an active
// free_welcome pack exists. The badge is the free pack's ONLY public surface
// (the catalog excludes the category — modules/packs/free-pack.ts), so this
// answer is per-customer and must not be cached across customers.
//
// AUTH: matcher registered in src/api/middlewares.ts with
// authenticate('customer', ['bearer'], { allowUnauthenticated: true }); an
// anonymous request carries no auth_context and gets the promo-only branch
// below. A verified bearer still gates the per-customer half — a caller can
// never read another customer's eligibility.
//
// The pack lookup is SKIPPED for an ineligible account — the common case once
// the welcome pack is claimed is one indexed read, not two.
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const customerId = req.auth_context?.actor_id;
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);

  // Anonymous visitor (allowUnauthenticated) — answer only the catalog fact
  // "an active free pack exists", so the storefront can show the signup-hook
  // badge. Nothing per-customer leaves on this branch, and `promo` appears
  // ONLY here: a linked-customer answer stays byte-identical to pre-promo
  // clients. (A fresh register token's actor_id is '' until POST
  // /store/customers links it — see medusa-register-token-empty-actor-id —
  // so that narrow window also falls into this branch; harmless since the
  // response shape is still boolean-or-absent, but it is not "authed" in
  // the linked-customer sense.)
  if (!customerId) {
    const active = await packs.getActiveFreePack();
    res.json({
      eligible: false,
      slug: null,
      image: null,
      promo: active != null,
    });
    return;
  }

  const [state] = await packs.listCustomerAccountStates(
    { customer_id: customerId },
    { take: 1 },
  );
  const active =
    state?.free_pack_available_at && !state?.free_pack_claimed_at
      ? await packs.getActiveFreePack()
      : null;

  res.json({
    eligible: active != null,
    slug: active?.slug ?? null,
    image: active?.image ?? null,
  });
}

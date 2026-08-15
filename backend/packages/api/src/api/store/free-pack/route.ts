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
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);

  // Anonymous visitor (allowUnauthenticated) — NO auth_context at all.
  // Answer only the catalog fact "an active free pack exists", so the
  // storefront can show the signup-hook badge. Nothing per-customer leaves
  // on this branch, and `promo` appears ONLY here.
  //
  // Branch on PRESENCE of auth_context, not actor_id truthiness: a fresh
  // register token carries auth_context with actor_id '' until POST
  // /store/customers links it (medusa-register-token-empty-actor-id). That
  // caller IS authenticated (auth_context present) and must fall through to
  // the per-customer path below — listCustomerAccountStates finds no row for
  // customer_id '', so it gets the same plain 3-key ineligible answer as any
  // other unstamped account, byte-identical to pre-promo clients. `== null`
  // (not `=== undefined`) so a hypothetical null auth_context is also
  // treated as anonymous rather than crashing on `.actor_id` below.
  if (req.auth_context == null) {
    const active = await packs.getActiveFreePack();
    res.json({
      eligible: false,
      slug: null,
      image: null,
      promo: active != null,
    });
    return;
  }

  const customerId = req.auth_context.actor_id;
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

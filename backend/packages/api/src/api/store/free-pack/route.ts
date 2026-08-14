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
// authenticate('customer', ['bearer']); the customer id comes ONLY from the
// verified token, so a caller can never read another customer's eligibility.
//
// The pack lookup is SKIPPED for an ineligible account — the common case once
// the welcome pack is claimed is one indexed read, not two.
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const customerId = req.auth_context.actor_id;
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);

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

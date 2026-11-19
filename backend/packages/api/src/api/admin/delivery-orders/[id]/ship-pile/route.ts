import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { PACKS_MODULE } from '../../../../../modules/packs';
import type PacksModuleService from '../../../../../modules/packs/service';

// POST /admin/delivery-orders/:id/ship-pile — the packer marks the parcel of
// an order cancelled from the ship pile as pulled, which takes it off the
// Orders page's alert (incident 2026-11-03). Writes one audit row
// naming the admin; a second press is a no-op. delivery_order:update through
// the prefix table, the same write the Orders page's status moves need, and
// the shared admin-action limiter (admin-rbac.ts). No body.
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const result = await packs.clearShipPile({
    orderId: req.params.id,
    adminId: req.auth_context.actor_id,
  });
  res.json(result);
}

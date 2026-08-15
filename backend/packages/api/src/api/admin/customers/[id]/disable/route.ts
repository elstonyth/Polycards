import type { AuthenticatedMedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../../../modules/packs';
import type PacksModuleService from '../../../../../modules/packs/service';
import { invalidateProfileForCustomer } from '../../../../../utils/profile-cache';

type Body = { reason?: unknown };

// POST /admin/customers/:id/disable — administrative LOGIN block (§4.2).
// Orthogonal to freeze: this does not touch the customer's funds. admin_id is
// derived from the verified auth_context (NEVER from the body). Admin routes
// are framework-auto-protected — no authenticate() middleware needed.
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const customerId = req.params.id;
  const adminId = req.auth_context.actor_id;
  const reason = (req.body as Body)?.reason;
  if (typeof reason !== 'string' || reason.trim() === '' || reason.length > 500) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'A reason (1–500 chars) is required.',
    );
  }
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  await packs.setAccountDisabled({
    customerId,
    adminId,
    disabled: true,
    reason: reason.trim(),
  });
  // The public profile is hidden from this moment (GET /store/profiles/:handle
  // 410s a disabled player), but a body cached BEFORE this call would keep
  // serving them for the rest of its 30s TTL. Evicting here closes that window
  // at the write instead of paying for a state read on every public cache hit —
  // the same seam the showcase toggle uses. Best-effort by contract, so it is
  // deliberately not guarded: a failed eviction costs ≤30s of staleness, never
  // a failed disable. The BOARDS keep their 30s window (their cache is keyed by
  // period, not by customer, so there is nothing customer-scoped to evict).
  await invalidateProfileForCustomer(req.scope, customerId);
  res.json({ disabled: true });
}

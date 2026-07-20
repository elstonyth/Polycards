import {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import PacksModuleService from '../../../../../modules/packs/service';
import { PACKS_MODULE } from '../../../../../modules/packs';
import { invalidateProfileForCustomer } from '../../../../../utils/profile-cache';

// Pure validation logic — extracted so it can be unit-tested without Medusa.
export function validateShowcaseRequest(
  pull: { customer_id: string; status: string } | undefined,
  callerId: string,
): 'ok' | 'not_found' | 'forbidden' | 'not_vaulted' {
  if (!pull) return 'not_found';
  if (pull.customer_id !== callerId) return 'forbidden';
  if (pull.status !== 'vaulted') return 'not_vaulted';
  return 'ok';
}

// POST /store/vault/:id/showcase — toggle whether a vaulted pull appears on the
// customer's public profile Collection.
//
// Body:   { showcased: boolean }
// 200:    { pull_id: string, showcased: boolean }
// 403:    pull doesn't belong to this customer
// 422:    pull is not currently vaulted (bought_back pulls can't be showcased)
//
// AUTH: registered in middlewares.ts — authenticate('customer', ['bearer']).
// The customer id comes ONLY from the verified token.
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const customerId = req.auth_context.actor_id;
  const pullId = req.params.id;
  // Guard the body shape first — an empty / non-JSON body must yield a clean
  // INVALID_DATA, never a TypeError on a property read of undefined.
  const body = req.body;
  if (
    !body ||
    typeof body !== 'object' ||
    typeof (body as { showcased?: unknown }).showcased !== 'boolean'
  ) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      '`showcased` must be a boolean',
    );
  }
  const showcased = (body as { showcased: boolean }).showcased;

  const packs: PacksModuleService = req.scope.resolve(PACKS_MODULE);
  const [pull] = await packs.listPulls({ id: pullId }, { take: 1 });

  const validation = validateShowcaseRequest(pull, customerId);
  if (validation === 'not_found') {
    throw new MedusaError(MedusaError.Types.NOT_FOUND, 'Pull not found');
  }
  if (validation === 'forbidden') {
    // Don't leak that someone else's pull exists — surface as 404, same as
    // not_found (matches the request-delivery cross-account pattern, CodeRabbit).
    throw new MedusaError(MedusaError.Types.NOT_FOUND, 'Pull not found');
  }
  if (validation === 'not_vaulted') {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'Only vaulted pulls can be showcased',
    );
  }

  // Atomic guard against the check→write race (#5): the filtered update writes
  // showcased ONLY while the pull is still vaulted and owned by this customer,
  // so a sell/deliver that flips status the instant after validateShowcaseRequest
  // loses — it matches 0 rows instead of stamping the flag onto a sold pull.
  // (Mirrors revealPull's first-write-wins filtered update.)
  const updated = await packs.updatePulls({
    selector: { id: pullId, customer_id: customerId, status: 'vaulted' },
    data: { showcased },
  });
  if (updated.length === 0) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'Only vaulted pulls can be showcased',
    );
  }

  // The star is only visible through GET /store/profiles/:handle (what /me and
  // the public profile render), and that route caches its body per handle for
  // 30s — without this eviction the toggle looks ignored for up to half a
  // minute. Best-effort by contract: the write already stood.
  await invalidateProfileForCustomer(req.scope, customerId);

  res.json({ pull_id: pullId, showcased });
}

import {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { ensureProfileHandleWorkflow } from '../../../../workflows/ensure-profile-handle';

// GET /store/profiles/me — the logged-in customer's public profile handle,
// assigned lazily on first request (idempotent — see the workflow). The
// storefront uses this to build the "My Profile" link; the profile data
// itself comes from the public GET /store/profiles/:handle like any other
// visitor would see it.
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  // Defense-in-depth (audit 2026-06-23): this route's auth currently relies on
  // the /store/profiles/me matcher being registered BEFORE the public
  // /store/profiles/* glob in middlewares.ts. Assert the authenticated actor
  // explicitly so correctness no longer depends on registration order (an
  // anonymous request that slipped through gets a clean 401, not a 500).
  const customerId = req.auth_context?.actor_id;
  if (!customerId) {
    throw new MedusaError(MedusaError.Types.UNAUTHORIZED, 'Unauthorized');
  }

  const { result } = await ensureProfileHandleWorkflow(req.scope).run({
    input: { customer_id: customerId },
  });
  res.json({ handle: result.handle });
}

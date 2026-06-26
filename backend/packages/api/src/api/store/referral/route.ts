import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError, Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../modules/packs';
import type PacksModuleService from '../../../modules/packs/service';
import { HANDLE_RE } from '../../../utils/profile-handle';
import { findCustomerByHandle } from '../../../utils/customer-by-handle';

type Body = { sponsor_id?: unknown; sponsor_handle?: unknown };

// GET /store/referral — the authenticated customer's referral summary.
//
// Privacy: directRecruits entries expose ONLY { handle, contribution } on the
// wire — raw customerId is NEVER emitted. Handle resolution is a no-N+1
// batch (listCustomers with an id[] filter), mirroring the leaderboard pattern.
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const customerId = req.auth_context?.actor_id;
  if (!customerId) {
    throw new MedusaError(MedusaError.Types.UNAUTHORIZED, 'Unauthorized');
  }

  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const s = await packs.referralSummary(customerId);

  // Batch-resolve handles for all gen-1 recruits in a single listCustomers
  // call — no N+1. Pattern mirrors store/leaderboard/route.ts:47-62.
  const ids = s.directRecruits.map((r) => r.customerId);
  const customerService = req.scope.resolve(Modules.CUSTOMER);
  const customers = ids.length
    ? await customerService.listCustomers({ id: ids }, { take: ids.length })
    : [];
  const handleById = new Map(
    customers.map((c) => {
      const handle = (c.metadata ?? {})['handle'];
      return [
        c.id,
        typeof handle === 'string' && HANDLE_RE.test(handle) ? handle : null,
      ];
    }),
  );

  res.json({
    directRecruits: s.directRecruits.map((r) => ({
      handle: handleById.get(r.customerId) ?? null,
      contribution: r.contribution,
    })),
    downstreamCount: s.downstreamCount,
    totalEarned: s.totalEarned,
  });
}

// POST /store/referral — the recruit sets their sponsor. recruitId is the
// verified token actor (NEVER the body). Accepts either:
//   { sponsor_handle } — resolved server-side to a customer id (preferred).
//   { sponsor_id }    — raw customer id, kept for back-compat.
// linkSponsor enforces self-referral / cycle / immutability under a dual-id lock.
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const recruitId = req.auth_context.actor_id;
  const body = req.body as Body;

  let sponsorId: string | undefined;

  if (typeof body?.sponsor_handle === 'string' && body.sponsor_handle.length > 0) {
    // Resolve handle server-side — NEVER trust a client-sent id when a handle
    // is supplied. Uses the same JSONB metadata query as findCustomerByHandle.
    const customerService = req.scope.resolve(Modules.CUSTOMER);
    const match = await findCustomerByHandle(customerService, body.sponsor_handle);
    if (!match) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        'No such referral handle.',
      );
    }
    sponsorId = match.id;
  } else if (typeof body?.sponsor_id === 'string' && body.sponsor_id.length > 0) {
    // Back-compat: existing callers that pass sponsor_id directly. Verify the id
    // points to a real customer before linking — the handle branch resolves
    // server-side, and the immutable one-shot sponsor edge must never be set to
    // an arbitrary/nonexistent id (F7).
    const customerService = req.scope.resolve(Modules.CUSTOMER);
    const [match] = await customerService.listCustomers(
      { id: body.sponsor_id },
      { take: 1 },
    );
    if (!match) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        'No such referral sponsor.',
      );
    }
    sponsorId = match.id;
  }

  if (!sponsorId) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'sponsor_handle or sponsor_id is required.',
    );
  }

  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const { id } = await packs.linkSponsor({ recruitId, sponsorId });
  res.status(201).json({ id });
}

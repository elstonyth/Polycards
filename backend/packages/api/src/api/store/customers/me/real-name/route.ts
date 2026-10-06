import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../../../modules/packs';
import type PacksModuleService from '../../../../../modules/packs/service';
import {
  normalizeRealName,
  REAL_NAME_INVALID,
} from '../../../../../utils/real-name';

type Body = { real_name?: unknown };

// GET /store/customers/me/real-name — the account's own real name, or null.
// What the storefront's account layout reads on EVERY account page for the
// real-name gate: one indexed single-row read, so the gate does not pay for
// the four-read GET /store/customers/me/account on each navigation.
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const customerId = req.auth_context?.actor_id;
  if (!customerId) {
    throw new MedusaError(MedusaError.Types.UNAUTHORIZED, 'Unauthorized');
  }
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const { realName } = await packs.getVerificationState(customerId);
  res.json({ real_name: realName });
}

// POST /store/customers/me/real-name — the customer's ONE-TIME real-name write
// (spec docs/superpowers/specs/2026-10-06-real-name-and-phone-lock-design.md).
// The storefront calls it right after signup and from the real-name gate /
// Settings for accounts that have none yet. Once a name is on file it is
// refused: only customer service changes it (POST /admin/customers/:id/real-name).
//
// The actor comes from the verified bearer, never the body. Register-token
// bearers carry actor_id '' until POST /store/customers links the identity
// (same guard as store/phone-verification/change).
export async function POST(
  req: AuthenticatedMedusaRequest<Body>,
  res: MedusaResponse,
): Promise<void> {
  const customerId = req.auth_context?.actor_id;
  if (!customerId) {
    throw new MedusaError(MedusaError.Types.UNAUTHORIZED, 'Unauthorized');
  }
  const realName = normalizeRealName(req.body?.real_name);
  if (!realName) {
    throw new MedusaError(MedusaError.Types.INVALID_DATA, REAL_NAME_INVALID);
  }
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  if (!(await packs.setRealName(customerId, realName))) {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      'Your real name is already on file and can’t be changed here. Contact customer service to correct it.',
    );
  }
  res.json({ real_name: realName });
}

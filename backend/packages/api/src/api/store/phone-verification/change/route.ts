import type { AuthenticatedMedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { MedusaError, Modules } from '@medusajs/framework/utils';
import type { ICustomerModuleService } from '@medusajs/framework/types';
import { E164_RE, verifyPhoneProof } from '../../../../utils/phone-verification';

// The ONLY way to set a new phone once enforcement is on (the /me gate in
// api/utils/phone-verification-guard.ts closes the core route). Actor comes
// from the verified bearer token, never the body.
type Body = { phone?: unknown; token?: unknown };

// `phone` isn't declared on FilterableCustomerProps (only has_account is) —
// same cast idiom as start/route.ts.
type CustomerFilters = Parameters<ICustomerModuleService['listCustomers']>[0];

export async function POST(
  req: AuthenticatedMedusaRequest<Body>,
  res: MedusaResponse,
): Promise<void> {
  // Register-token bearers carry actor_id '' until POST /store/customers
  // links the identity (same guard as store/vip/route.ts) — without this,
  // updateCustomers('', …) below reaches core with an empty id and 500s
  // instead of cleanly rejecting the caller.
  const customerId = req.auth_context.actor_id;
  if (!customerId) {
    throw new MedusaError(MedusaError.Types.UNAUTHORIZED, 'Unauthorized');
  }

  const { phone, token } = req.body ?? {};
  if (typeof phone !== 'string' || !E164_RE.test(phone))
    throw new MedusaError(MedusaError.Types.INVALID_DATA, 'Invalid phone number.');

  const { jwtSecret } = req.scope.resolve('configModule').projectConfig.http;
  // jwtSecret is typed `Secret` (string | Buffer | ...) by the framework, not
  // `string` (see store/phone-verification/check/route.ts and
  // utils/phone-verification-guard.ts's secretOf); verifyPhoneProof's HMAC
  // needs a plain string, so a non-string secret is treated the same as
  // unconfigured.
  if (typeof jwtSecret !== 'string' || !jwtSecret)
    throw new MedusaError(MedusaError.Types.UNEXPECTED_STATE, 'Server misconfigured.');

  const proof =
    typeof token === 'string' ? verifyPhoneProof(jwtSecret, token, 'phone-change') : null;
  if (!proof || proof.phone !== phone)
    throw new MedusaError(MedusaError.Types.INVALID_DATA, 'Phone verification required.');

  const customerService: ICustomerModuleService = req.scope.resolve(Modules.CUSTOMER);

  // The OTP proof only establishes the CALLER can receive SMS at this number
  // — it says nothing about whether another account already owns it (ported
  // number, two people typing the same digits). Same CustomerFilters cast
  // idiom as start/route.ts.
  const matches = await customerService.listCustomers(
    { phone, has_account: true } as unknown as CustomerFilters,
    { select: ['id'], take: 2 },
  );
  if (matches.some((c) => c.id !== customerId))
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      'This phone number is already in use.',
    );

  await customerService.updateCustomers(customerId, { phone });
  res.json({ customer: { id: customerId, phone } });
}

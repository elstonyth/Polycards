import type {
  MedusaNextFunction,
  MedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import {
  isPhoneVerificationRequired,
  verifyPhoneProof,
} from '../../utils/phone-verification';

// The two write gates that make phone verification MANDATORY (everything in
// Task 2 is opt-in plumbing until these exist). Both read the env flag per
// request so the http specs can flip it without rebooting the app.
//
// Scope note: a phoneless direct-API signup already bypasses the storefront's
// "phone required" rule today; these gates keep that scope (they verify the
// phone IF one is written, they don't add a phone-presence requirement).

export const PHONE_VERIFICATION_HEADER = 'x-phone-verification';

const secretOf = (req: MedusaRequest): string => {
  const secret = req.scope.resolve('configModule').projectConfig.http.jwtSecret;
  // jwtSecret is typed `Secret` (string | Buffer | ...) by the framework, not
  // `string` (see src/api/store/phone-verification/check/route.ts);
  // verifyPhoneProof's HMAC needs a plain string, so a non-string secret is
  // treated the same as unconfigured.
  if (typeof secret !== 'string' || !secret)
    throw new MedusaError(MedusaError.Types.UNEXPECTED_STATE, 'Server misconfigured.');
  return secret;
};

/** POST /store/customers — a signup that writes a phone must prove it. */
export const requireSignupPhoneProof = (
  req: MedusaRequest<{ phone?: unknown }>,
  _res: MedusaResponse,
  next: MedusaNextFunction,
): void => {
  if (!isPhoneVerificationRequired(process.env)) return next();
  const phone = req.body?.phone;
  if (typeof phone !== 'string') return next(); // Google signup has no phone
  const header = req.headers[PHONE_VERIFICATION_HEADER];
  const token = typeof header === 'string' ? header : '';
  const proof = token ? verifyPhoneProof(secretOf(req), token, 'signup') : null;
  if (!proof || proof.phone !== phone) {
    // next(err) — repo convention for surfacing middleware errors (see
    // blockUnusedVendorSelfRegistration in middlewares.ts).
    return next(
      new MedusaError(MedusaError.Types.INVALID_DATA, 'Phone verification required.'),
    );
  }
  next();
};

/** POST /store/customers/me — phone CHANGES go through the verified route
 *  (store/phone-verification/change); clearing to null stays allowed. */
export const blockUnverifiedPhoneWrite = (
  req: MedusaRequest<{ phone?: unknown }>,
  _res: MedusaResponse,
  next: MedusaNextFunction,
): void => {
  if (!isPhoneVerificationRequired(process.env)) return next();
  if (typeof req.body?.phone === 'string') {
    return next(
      new MedusaError(
        MedusaError.Types.INVALID_DATA,
        'Phone changes require verification.',
      ),
    );
  }
  next();
};

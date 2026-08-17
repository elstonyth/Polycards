import type {
  AuthenticatedMedusaRequest,
  MedusaNextFunction,
  MedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { assertPhoneUnclaimed } from './phone-claim';
import { PACKS_MODULE } from '../../modules/packs';
import type PacksModuleService from '../../modules/packs/service';
import {
  isPhoneGateRequired,
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
    throw new MedusaError(
      MedusaError.Types.UNEXPECTED_STATE,
      'Server misconfigured.',
    );
  return secret;
};

/**
 * POST /store/customers — a signup that writes a phone must prove it, and must
 * not reuse a number another account already holds.
 */
export const requireSignupPhoneProof = async (
  req: MedusaRequest<{ phone?: unknown }>,
  _res: MedusaResponse,
  next: MedusaNextFunction,
): Promise<void> => {
  const phone = req.body?.phone;
  if (typeof phone !== 'string') return next(); // Google signup has no phone

  if (isPhoneVerificationRequired(process.env)) {
    const header = req.headers[PHONE_VERIFICATION_HEADER];
    const token = typeof header === 'string' ? header : '';
    const proof = token
      ? verifyPhoneProof(secretOf(req), token, 'signup')
      : null;
    if (!proof || proof.phone !== phone) {
      // next(err) — repo convention for surfacing middleware errors (see
      // blockUnusedVendorSelfRegistration in middlewares.ts).
      return next(
        new MedusaError(
          MedusaError.Types.INVALID_DATA,
          'Phone verification required.',
        ),
      );
    }
  }

  // One phone = one account. Runs whatever the flag says —
  // PHONE_VERIFICATION_REQUIRED is the fail-open rollback lever for whether a
  // phone must be VERIFIED (CONTEXT.md), and pulling it must not reopen
  // multi-accounting — but deliberately AFTER the proof check above, not
  // before. The two refusals are distinguishable, so a duplicate-first order
  // makes this route the very "does this number have an account" oracle that
  // store/phone-verification/check is placed to avoid: a register token is
  // reusable until it links a customer, so one token would probe unlimited
  // numbers with no OTP. Behind the proof, only a caller who has already
  // proven possession of the number can read the answer.
  //
  // Why this site exists at all when the check route refuses duplicates too:
  // that one is what gives the user a usable error (it fires before the auth
  // identity is registered), this one is authoritative. A proof is good for 10
  // minutes and is not single-use, so without this a token minted while the
  // number was free still creates the second account.
  //
  // A throw here reaches the error handler: the framework registers
  // defineMiddlewares entries through wrapHandler, which awaits and forwards to
  // next(err) (framework/dist/http/{router,utils/wrap-handler}.js).
  await assertPhoneUnclaimed(req.scope, phone);
  next();
};

/**
 * Money in / goods out: the caller must have COMPLETED phone verification at
 * some point, not merely be holding a fresh OTP proof. That is a persisted
 * fact (`customer_account_state.phone_verified_at`), stamped by the
 * phone-change route and the signup subscriber.
 *
 * Deliberately NOT applied to cancel/read routes: a player who has not
 * verified must still be able to unwind an order and see their own data —
 * the gate exists to stop unverified value MOVING, not to lock the account.
 *
 * Gated on its OWN flag (isPhoneGateRequired), which falls back to
 * PHONE_VERIFICATION_REQUIRED when unset: blocking every unverified account
 * from topping up is a far larger blast radius than refusing an unproven phone
 * WRITE, and the two have to be rollback-able separately.
 *
 * Reads the env flag per request for the same reason the two gates above do:
 * the http specs flip it without rebooting the app.
 */
export const requirePhoneVerified = async (
  req: AuthenticatedMedusaRequest,
  _res: MedusaResponse,
  next: MedusaNextFunction,
): Promise<void> => {
  if (!isPhoneGateRequired(process.env)) return next();
  const customerId = req.auth_context?.actor_id;
  // Register-token bearers carry actor_id '' until POST /store/customers links
  // the identity (same guard as store/phone-verification/change). No actor =
  // nothing to check the state row against, so refuse rather than pass.
  if (!customerId) {
    return next(
      new MedusaError(MedusaError.Types.UNAUTHORIZED, 'Unauthorized'),
    );
  }
  try {
    const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
    if (await packs.isPhoneVerified(customerId)) return next();
  } catch (e) {
    // Fail CLOSED. A read failure here must not become a free pass on a money
    // path; the caller retries, and the storefront copy already tells them
    // what to do next.
    return next(e as Error);
  }
  next(
    new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      'Verify your phone number before continuing.',
    ),
  );
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

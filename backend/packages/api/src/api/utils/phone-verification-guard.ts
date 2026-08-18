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

/**
 * Admin-side counterpart to blockUnverifiedPhoneWrite above: the generic
 * admin customer routes (POST /admin/customers create, POST
 * /admin/customers/:id update) may NOT write `phone` at all — unlike the
 * store-side signup gate, this does not route the value through
 * assertPhoneUnclaimed. It refuses the field outright.
 *
 * Why not "force has_account and call assertPhoneUnclaimed", the way
 * requireSignupPhoneProof does above: that was considered and rejected.
 * has_account means "this row has a login identity"; forcing it true on a
 * row the admin route creates without one would be a lie about the row's
 * login state. It would also corrupt core's composite (email, has_account)
 * unique index, which exists SPECIFICALLY so a guest row can share an email
 * with a real account (@medusajs/customer models/customer.js — the index is
 * declared `on: ["email", "has_account"]`, unique, `where: "deleted_at IS
 * NULL"`). And because assertPhoneUnclaimed only ever compares against
 * has_account: true rows, forcing the flag on write would let an admin
 * silently claim a phone number away from whichever real account currently
 * holds it, rather than refuse the write.
 *
 * The gap this closes: core's admin create (POST /admin/customers,
 * @medusajs/medusa admin/customers/route.js) calls createCustomersWorkflow
 * directly — NOT createCustomerAccountWorkflow, the one POST /store/customers
 * uses to force `has_account: !!authIdentityId` in the same transform that
 * carries the phone field (@medusajs/core-flows
 * create-customer-account.js). Nothing on the admin path sets has_account,
 * so it falls back to the Customer model's default of `false`
 * (@medusajs/customer models/customer.js). Both AdminCreateCustomer and
 * AdminUpdateCustomer accept a bare `phone: z.string().nullish()`
 * (@medusajs/medusa admin/customers/validators.js), with nothing upstream
 * refusing it — so, absent this guard, an admin caller could create (or add
 * to) a has_account: false row holding a phone: invisible to
 * assertPhoneUnclaimed and to scripts/report-duplicate-phones.ts, both of
 * which filter has_account: true. See phone-claim.ts's docblock for the
 * full invariant this protects.
 *
 * Why UPDATE and not just CREATE: blocking create alone leaves the same hole
 * open a different way. Core's cart flow creates guest customers
 * (has_account: false, `{ email }` only) through findOrCreateCustomerStep
 * (@medusajs/core-flows cart/steps/find-or-create-customer.js); without this
 * half, an admin could add a phone to one of those rows through
 * POST /admin/customers/:id and reproduce the exact invisible-row condition.
 * Same guard, second matcher — see middlewares.ts.
 *
 * Rejects on PRESENCE of the key, not truthiness — `phone: null` and
 * `phone: ''` are refused too. A null write is still a write to a column
 * whose ownership this guard exists to protect, and admitting it invites a
 * future partial-update path that silently clears a number the OTP flow
 * set. Fail-closed, same reasoning as rejectCustomerMetadata's "reject the
 * whole field" (customer-metadata-guard.ts).
 *
 * Honest tradeoff: this removes the ability to set or correct a customer's
 * phone through the generic admin route, full stop. Nothing in this repo
 * does that today — apps/admin/src only READS phone (type declarations and
 * list/detail display in lib/admin-rest.ts, routes/players/page.tsx,
 * routes/customers/[id]/page.tsx); there is no customer-create or
 * customer-edit screen, and nothing POSTs a phone to /admin/customers or
 * /admin/customers/:id. If support ever needs to correct a phone, that
 * calls for a purpose-built, audited route that goes through
 * assertPhoneUnclaimed — not a carve-out here.
 */
export function rejectAdminPhoneWrite(
  req: MedusaRequest,
  _res: MedusaResponse,
  next: MedusaNextFunction,
): void {
  const body = req.body as Record<string, unknown> | null | undefined;
  if (body && typeof body === 'object' && 'phone' in body) {
    next(
      new MedusaError(
        MedusaError.Types.INVALID_DATA,
        'phone is not writable through this route. Phone numbers are bound through OTP verification (store/phone-verification), which is what keeps one phone tied to one account.',
      ),
    );
    return;
  }
  next();
}

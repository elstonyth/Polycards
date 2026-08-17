import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError, Modules } from '@medusajs/framework/utils';
import type {
  IAuthModuleService,
  ICustomerModuleService,
  INotificationModuleService,
} from '@medusajs/framework/types';
import {
  E164_RE,
  verifyPhoneProof,
} from '../../../../utils/phone-verification';
import { assertPhoneUnclaimed } from '../../../utils/phone-claim';
import { PACKS_MODULE } from '../../../../modules/packs';
import type PacksModuleService from '../../../../modules/packs/service';
import { isResendConfigured } from '../../../../modules/resend/options';
import { PHONE_CHANGED_TEMPLATE } from '../../../../modules/resend/templates';

// The ONLY way to set a new phone once enforcement is on (the /me gate in
// api/utils/phone-verification-guard.ts closes the core route). Actor comes
// from the verified bearer token, never the body.
//
// `password` / `old_phone_token` are the re-auth proof — see the gate below
// for which of the two a given account must supply.
type Body = {
  phone?: unknown;
  token?: unknown;
  password?: unknown;
  old_phone_token?: unknown;
};

// Last 4 digits only. The masked pair rides an email body and a persisted
// notification row (GET /admin/notifications exposes `data` to any admin —
// the same surface subscribers/password-reset.ts documents as accepted risk),
// so the full number must never appear there.
//
// The NEW number passed E164_RE this request (>= 7 digits after the '+'), so
// slice(-4) always drops something. The OLD one is whatever the DB holds and
// was NOT validated here — the duplicate-check comment below notes legacy rows
// predating verification — so a stored value of 4 characters or fewer masks to
// itself. That is the pre-existing value being echoed back to its own owner's
// inbox, not a new disclosure, but do not read this as a length guarantee.
const mask = (phone: string): string => `••••${phone.slice(-4)}`;

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
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'Invalid phone number.',
    );

  const { jwtSecret } = req.scope.resolve('configModule').projectConfig.http;
  // jwtSecret is typed `Secret` (string | Buffer | ...) by the framework, not
  // `string` (see store/phone-verification/check/route.ts and
  // utils/phone-verification-guard.ts's secretOf); verifyPhoneProof's HMAC
  // needs a plain string, so a non-string secret is treated the same as
  // unconfigured.
  if (typeof jwtSecret !== 'string' || !jwtSecret)
    throw new MedusaError(
      MedusaError.Types.UNEXPECTED_STATE,
      'Server misconfigured.',
    );

  const proof =
    typeof token === 'string'
      ? verifyPhoneProof(jwtSecret, token, 'phone-change')
      : null;
  if (!proof || proof.phone !== phone)
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'Phone verification required.',
    );

  const customerService: ICustomerModuleService = req.scope.resolve(
    Modules.CUSTOMER,
  );

  // ── RE-AUTH GATE ───────────────────────────────────────────────────────────
  // WHY: before this gate, a stolen customer session was permanent account
  // takeover. This route asked for no current password and sent no OTP to the
  // OLD number, and it also runs markPhoneVerified below — so one call moved
  // the recovery phone to an attacker's handset AND satisfied
  // requirePhoneVerified. The downstream consumer that closes the loop is
  // ../password-reset/route.ts: it resolves the target account from whatever
  // phone is on the row NOW and mints a real emailpass reset token, so the
  // attacker OTPs their own number, resets the password, and the owner is
  // locked out of both the account and phone recovery.
  //
  // Placed AFTER the proof check on purpose: a caller without a valid
  // new-number proof is rejected before any password is examined, so this
  // cannot be used as a password oracle.
  //
  // Deliberately NOT gated on PHONE_VERIFICATION_REQUIRED. That flag governs
  // whether a phone must be VERIFIED (its fail-open rollback lever, see
  // CONTEXT.md); it has never governed whether identity must be PROVEN to move
  // one, and the takeover chain above works either way.
  const current = await customerService.retrieveCustomer(customerId, {
    select: ['id', 'email', 'phone'],
  });

  // No readable email = no way to tell an emailpass account from a Google-only
  // one, since both branches below key off it. Refuse rather than fall through
  // to the unguarded first-time branch, which would be a free pass.
  const email = current.email;
  if (typeof email !== 'string' || email === '')
    throw new MedusaError(
      MedusaError.Types.UNEXPECTED_STATE,
      'Server misconfigured.',
    );

  const authService = req.scope.resolve<IAuthModuleService>(Modules.AUTH);
  // Same filter shape as scripts/reset-customer-password.ts:42-45. An account
  // holding BOTH emailpass and Google identities lands in the password branch;
  // that is the stricter of the two and is intentional — don't "fix" it by
  // preferring the phone proof.
  const emailpassIdentities = await authService.listAuthIdentities(
    { provider_identities: { entity_id: email, provider: 'emailpass' } },
    { relations: ['provider_identities'] },
  );

  if (emailpassIdentities.length > 0) {
    // CONTRACT (read from the installed provider, not assumed):
    // node_modules/@medusajs/auth-emailpass/dist/services/emailpass.js:94-97
    // RETURNS `{ success: false, error: 'Invalid email or password' }` for a
    // wrong password — it does not throw. Nor does anything else on this path:
    // @medusajs/auth/dist/services/auth-module.js:73-80 wraps the provider call
    // in try/catch and converts every throw into the same failure object.
    // A failure is therefore a TRUTHY object, so `if (result)` or `if
    // (!result.error)` would pass for a wrong password. Gate on
    // `success === true` and nothing else.
    const password = req.body?.password;
    const reauthed =
      typeof password === 'string' && password !== ''
        ? await authService.authenticate('emailpass', {
            body: { email, password },
          })
        : null;
    if (reauthed?.success !== true)
      throw new MedusaError(
        MedusaError.Types.UNAUTHORIZED,
        'Enter your current password to change your phone number.',
      );
  } else if (typeof current.phone === 'string' && current.phone !== '') {
    // Google-only account that already has a phone: there is no password to
    // ask for, so the equivalent proof is an OTP to the number being moved
    // AWAY from — which the attacker, by definition, cannot receive.
    const oldToken = req.body?.old_phone_token;
    const oldProof =
      typeof oldToken === 'string'
        ? verifyPhoneProof(jwtSecret, oldToken, 'phone-change')
        : null;
    if (!oldProof || oldProof.phone !== current.phone)
      throw new MedusaError(
        MedusaError.Types.UNAUTHORIZED,
        'Verify your current phone number to change it.',
      );
  }
  // else: Google-only account with NO phone yet — first-time verification.
  // The ONE path that keeps working on the new-number proof alone, and it is
  // safe for the same reason the branch above is needed: with no emailpass
  // identity there is nothing for password-reset/route.ts to hand over (it
  // refuses a Google-only account outright), so adding a first phone here
  // cannot be converted into a password takeover. An emailpass account adding
  // its FIRST phone does not qualify and takes the password branch above.
  // ── END RE-AUTH GATE ───────────────────────────────────────────────────────

  // One phone = one account — shared with the two signup sites (see
  // api/utils/phone-claim.ts for why it is a check and not a constraint).
  await assertPhoneUnclaimed(req.scope, phone, customerId);

  await customerService.updateCustomers(customerId, { phone });
  // Persist the FACT of verification — the proof token above expires in 10
  // minutes, so the topup/delivery gates (requirePhoneVerified) need a stored
  // stamp. After the write: a stamp on an account whose phone never landed
  // would be a lie. Idempotent + first-write-wins in the service.
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  await packs.markPhoneVerified(customerId);

  // Tell the account its recovery phone moved. Sent to the EMAIL, never to
  // either number: email is the one channel an attacker who has just taken the
  // phone has not taken, so it is the only place this warning can still land
  // with the real owner. Skipped when `current.phone` was empty — a first-time
  // add is not a change and there is nothing to warn about.
  //
  // Deliberately a direct send rather than an event + subscriber: this repo has
  // no event-bus emit anywhere in src/ (nothing to pattern-match on), and the
  // failure requirement below is only expressible in-process — through a bus,
  // a delivery failure is invisible to this handler.
  //
  // Best-effort, after the write commits, and it NEVER throws: the phone change
  // is already persisted, so failing the request here would report failure for
  // something that succeeded and invite a confused retry.
  if (typeof current.phone === 'string' && current.phone !== '') {
    try {
      // Same predicate medusa-config.ts registers the provider on. Without it,
      // no provider is bound to the `email` channel and createNotifications
      // throws NOT_FOUND on every local phone change — caught below, but the
      // warn would be pure noise in dev.
      if (isResendConfigured(process.env)) {
        const notifications = req.scope.resolve<INotificationModuleService>(
          Modules.NOTIFICATION,
        );
        await notifications.createNotifications({
          to: email,
          channel: 'email',
          template: PHONE_CHANGED_TEMPLATE,
          // Masked — see `mask` above for why the full numbers cannot ride here.
          data: {
            old_phone_masked: mask(current.phone),
            new_phone_masked: mask(phone),
          },
        });
      }
    } catch (e) {
      // PRIVACY: customer id only. The phone numbers and the email address are
      // PII and prod logs (DO runtime, a SIEM/Sentry sink) are a wider audience
      // than this warn needs — same rule as scripts/reset-customer-password.ts.
      // The provider's own error text is NOT interpolated: a notification
      // provider names the failed recipient in it ("... to alice@example.com"),
      // which would put the email address in the logs through the back door and
      // undo the rule this comment states.
      req.scope
        .resolve('logger')
        .warn(
          `[phone-change] could not email the change notice for customer ${customerId} — phone already updated`,
        );
    }
  }

  res.json({ customer: { id: customerId, phone } });
}

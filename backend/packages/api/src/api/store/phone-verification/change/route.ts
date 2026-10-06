import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError, Modules } from '@medusajs/framework/utils';
import type {
  IAuthModuleService,
  ICustomerModuleService,
} from '@medusajs/framework/types';
import {
  E164_RE,
  verifyPhoneProof,
} from '../../../../utils/phone-verification';
import { assertPhoneUnclaimed } from '../../../utils/phone-claim';
import { linkedEmailpassLogin } from '../../../utils/linked-login';
import { PACKS_MODULE } from '../../../../modules/packs';
import type PacksModuleService from '../../../../modules/packs/service';

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

// The phone lock's refusal (spec 2026-10-06) — the storefront matches its text.
const PHONE_LOCKED_MESSAGE =
  'Your phone number is verified and can’t be changed here. Contact customer service to change it.';
const PHONE_PINNED_MESSAGE =
  'You can only verify the number already on your account. To use a different number, contact customer service.';

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

  // PHONE LOCK (spec 2026-10-06): once an account has verified a number, the
  // customer can never move it — the number is how staff tie the account to
  // one person (Touch 'n Go name check), and a movable number would let one
  // person recycle it across farmed accounts. Customer service moves it
  // instead (POST /admin/customers/:id/phone, audited). An account that has
  // never verified — a Google signup adding its first number, a legacy
  // pre-enforcement phone — still comes through here exactly once. Checked
  // first: a locked account has nothing to prove, so nothing below runs.
  // Unconditional, like the re-auth gate below: not part of the
  // PHONE_VERIFICATION_REQUIRED rollback lever.
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  if (await packs.isPhoneVerified(customerId)) {
    throw new MedusaError(MedusaError.Types.NOT_ALLOWED, PHONE_LOCKED_MESSAGE);
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

  // PHONE LOCK, second half (spec 2026-10-06): an account that already holds a
  // number it never verified (written before verification was enforced) may
  // verify THAT number, not swap it for another — "old customers cannot change
  // their phone either". A number they no longer own is customer service's to
  // replace. Only an account with no number at all picks a new one here.
  if (
    typeof current.phone === 'string' &&
    current.phone !== '' &&
    current.phone !== phone
  ) {
    throw new MedusaError(MedusaError.Types.NOT_ALLOWED, PHONE_PINNED_MESSAGE);
  }

  // No readable email = nowhere to send the change notice below, and a row in
  // a state this route was never designed for. Refuse rather than fall through
  // to the unguarded first-time branch, which would be a free pass.
  const email = current.email;
  if (typeof email !== 'string' || email === '')
    throw new MedusaError(
      MedusaError.Types.UNEXPECTED_STATE,
      'Server misconfigured.',
    );

  const authService = req.scope.resolve<IAuthModuleService>(Modules.AUTH);
  // The password login LINKED to this customer — not any emailpass identity
  // that merely shares its email (see linkedEmailpassLogin for the 2026-09-30
  // incident that distinction caused). An account holding BOTH emailpass and
  // Google identities lands in the password branch; that is the stricter of the
  // two and is intentional — don't "fix" it by preferring the phone proof.
  const passwordLogin = await linkedEmailpassLogin(req.scope, customerId);

  if (passwordLogin) {
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
            body: { email: passwordLogin, password },
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
  // would be a lie. Idempotent + first-write-wins in the service. From here
  // the number is locked (the PHONE LOCK check at the top of this handler).
  await packs.markPhoneVerified(customerId);

  // No change notice: with the phone lock (spec 2026-10-06) this route only
  // ever ADDS a first number or verifies the one already on file — it never
  // moves a number away from anyone, so there is nothing to warn about. The
  // one remaining move, customer service's, emails the account
  // (admin/customers/[id]/phone, api/utils/phone-changed-notice.ts).

  res.json({ customer: { id: customerId, phone } });
}

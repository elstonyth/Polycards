import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { MedusaError, Modules } from '@medusajs/framework/utils';
import type { ICustomerModuleService } from '@medusajs/framework/types';
import { generateResetPasswordTokenWorkflow } from '@medusajs/core-flows';
import { verifyPhoneProof } from '../../../../utils/phone-verification';

// Workflow contract (Task 5 Step 1 — verified against @medusajs/medusa dist
// and @medusajs/core-flows dist, not guessed):
//
// Core's own POST /auth/:actor_type/:auth_provider/reset-password
// (node_modules/@medusajs/medusa/dist/api/auth/[actor_type]/[auth_provider]/reset-password/route.js)
// calls:
//   generateResetPasswordTokenWorkflow(req.scope).run({
//     input: { entityId: identifier, actorType: actor_type, provider: auth_provider,
//              secret: http.jwtSecret, jwtOptions: http.jwtOptions, metadata },
//     throwOnError: false, // core opts OUT of throwing, specifically to avoid
//   })                     // leaking "identity not found" to a caller who
//                           // only supplied an email/username.
// generateResetPasswordTokenWorkflow's input type (core-flows dist
// generate-reset-password-token.d.ts) is
//   { entityId: string; actorType: string; provider: string;
//     secret: Secret; jwtOptions?: JwtOptions; metadata?: Record<string, unknown> }
// — entityId/actorType/provider/secret are the only REQUIRED fields, so the
// brief's 4-field call is a valid subset (jwtOptions/metadata just default).
//
// The workflow body (core-flows dist generate-reset-password-token.js):
//   providerIdentity = remoteQuery(provider_identity where entity_id=entityId, provider=provider)[0]
//   if (!providerIdentity) throw MedusaError(INVALID_DATA, `Provider identity with entity_id ${entityId} and provider ${provider} not found`)
//   token = generateJwtToken({entity_id, provider, actor_type}, {secret, expiresIn: '15m', jwtOptions})
//   emitEventStep(auth.password_reset, {entity_id, actor_type, token, metadata})
//   return new WorkflowResponse(token)
// — so `result` from `.run()` IS the token string directly (the workflow's
// .d.ts types it `ReturnWorkflow<Input, string, []>` — output type `string`,
// confirmed, not optional), so no local JWT-signing fallback is needed here.
//
// We deliberately do NOT pass throwOnError:false like core does — we've
// ALREADY resolved a real customer by phone before calling this, so "identity
// not found" here means something core's own endpoint never has to handle:
// an account that exists but has no `emailpass` provider identity (a
// Google-only signup). We want that to surface so we can turn it into a
// clear message instead of a silently-unusable reset link.
//
// Exchanges phone-possession proof for the SAME single-use 15m reset token the
// email flow issues, so the whole downstream path is reused unchanged:
// /reset-password page → /auth/customer/emailpass/update → single-use guard
// (src/api/utils/reset-token-guard.ts, matcher '/auth/*/emailpass/update' in
// middlewares.ts already covers this route's output token automatically).
// Running the core workflow also emits auth.password_reset, so the account's
// EMAIL gets the usual reset mail too — deliberate: it doubles as a security
// notification, and both links carry the same token, so using one dead-ends
// the other via the single-use guard.
//
// Enumeration stance: the caller has already proven possession of the phone
// (OTP passed), so "no account uses this phone" is disclosable to them —
// same standard the email-flow confirmation copy protects against, different
// trust level. Legacy phones stored non-E.164 (pre-2026-08 rows) won't match
// the exact-match lookup; those users reset by email. ponytail: exact match
// only, add normalization backfill only if support volume says so.
type Body = { token?: unknown };

// `phone` isn't declared on FilterableCustomerProps (only has_account is) —
// same cast pattern as findCustomerByHandle (utils/customer-by-handle.ts) and
// store/phone-verification/start/route.ts.
type CustomerFilters = Parameters<ICustomerModuleService['listCustomers']>[0];

const maskEmail = (email: string): string => {
  const [local = '', domain = ''] = email.split('@');
  return `${local.slice(0, 1)}${'*'.repeat(Math.max(local.length - 1, 2))}@${domain}`;
};

export async function POST(req: MedusaRequest<Body>, res: MedusaResponse): Promise<void> {
  const { token } = req.body ?? {};
  const { jwtSecret } = req.scope.resolve('configModule').projectConfig.http;
  // jwtSecret is typed `Secret` (string | Buffer | ...) by the framework, not
  // `string` (see store/phone-verification/check/route.ts); verifyPhoneProof's
  // HMAC needs a plain string, so a non-string secret is treated the same as
  // unconfigured.
  if (typeof jwtSecret !== 'string' || !jwtSecret)
    throw new MedusaError(MedusaError.Types.UNEXPECTED_STATE, 'Server misconfigured.');

  const proof =
    typeof token === 'string' ? verifyPhoneProof(jwtSecret, token, 'password-reset') : null;
  if (!proof)
    throw new MedusaError(MedusaError.Types.INVALID_DATA, 'Phone verification required.');

  const customerService: ICustomerModuleService = req.scope.resolve(Modules.CUSTOMER);
  const matches = await customerService.listCustomers(
    { phone: proof.phone, has_account: true } as unknown as CustomerFilters,
    { select: ['id', 'email'], take: 2 },
  );
  if (matches.length === 0)
    throw new MedusaError(MedusaError.Types.NOT_FOUND, 'No account uses this phone number.');
  if (matches.length > 1)
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      'More than one account uses this phone number. Reset by email instead.',
    );

  const email = matches[0].email;
  let result: string;
  try {
    ({ result } = await generateResetPasswordTokenWorkflow(req.scope).run({
      input: {
        entityId: email,
        actorType: 'customer',
        provider: 'emailpass',
        secret: jwtSecret,
      },
    }));
  } catch (err) {
    // The workflow's only synchronous throw point is the missing-provider-
    // identity check above (INVALID_DATA) — a customer we just resolved by
    // phone but who never set up an emailpass login (Google-only signup).
    // Duck-type on `.type` rather than `instanceof MedusaError`: verified via
    // http spec that the error crossing the workflow-engine boundary fails
    // an `instanceof` check here (a dual-package-hazard symptom — the
    // engine's own @medusajs/utils resolution isn't guaranteed to be the
    // same module instance as this route's) even though `.type` is intact.
    // Same duck-typing idiom @medusajs/auth-emailpass's own service uses
    // for the identical reason (its `authenticate`/`register` methods check
    // `error.type === MedusaError.Types.NOT_FOUND`, never `instanceof`).
    if ((err as { type?: string })?.type === MedusaError.Types.INVALID_DATA) {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        'This account signs in with Google.',
      );
    }
    throw err;
  }
  res.json({ token: result, maskedEmail: maskEmail(email) });
}

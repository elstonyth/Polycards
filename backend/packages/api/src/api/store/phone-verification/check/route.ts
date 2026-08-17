import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import {
  E164_RE,
  checkPhoneOtpCode,
  isPhoneOtpPurpose,
  signPhoneProof,
} from '../../../../utils/phone-verification';
import { assertPhoneUnclaimed } from '../../../utils/phone-claim';

// Public: exchanges a correct OTP for a 10m proof token. The token is the
// only artifact downstream gates trust — the code itself never travels
// further than this route.
type Body = { phone?: unknown; purpose?: unknown; code?: unknown };

export async function POST(
  req: MedusaRequest<Body>,
  res: MedusaResponse,
): Promise<void> {
  const { phone, purpose, code } = req.body ?? {};
  if (typeof phone !== 'string' || !E164_RE.test(phone))
    throw new MedusaError(MedusaError.Types.INVALID_DATA, 'Invalid phone number.');
  if (!isPhoneOtpPurpose(purpose))
    throw new MedusaError(MedusaError.Types.INVALID_DATA, 'Invalid purpose.');
  if (typeof code !== 'string' || !/^\d{4,10}$/.test(code))
    throw new MedusaError(MedusaError.Types.INVALID_DATA, 'Invalid or expired code.');

  const logger = req.scope.resolve('logger') as { warn: (msg: string) => void };
  const approved = await checkPhoneOtpCode(process.env, logger, phone, code);
  if (!approved)
    throw new MedusaError(MedusaError.Types.INVALID_DATA, 'Invalid or expired code.');

  // One phone = one account. Refused HERE, and not at `start`, because this is
  // the first point the caller has PROVEN they hold the number — an earlier
  // refusal would turn a public route into a "does this number have an account"
  // oracle for anyone who can type digits.
  //
  // Signup only: 'phone-change' does its own check (it must exempt the caller's
  // own row), and 'password-reset' exists precisely BECAUSE the number is
  // already on an account.
  //
  // The signup gate (utils/phone-verification-guard.ts) repeats this because it
  // is the authoritative one; this site is what keeps the failure usable —
  // storefront signup() registers the auth identity BEFORE POST
  // /store/customers, so a refusal there leaves the email stranded on an
  // identity with no customer row.
  if (purpose === 'signup') await assertPhoneUnclaimed(req.scope, phone);

  const { jwtSecret } = req.scope.resolve('configModule').projectConfig.http;
  // jwtSecret is typed `Secret` (string | Buffer | ...) by the framework;
  // signPhoneProof's HMAC needs a plain string, so a non-string secret is
  // treated the same as unconfigured.
  if (typeof jwtSecret !== 'string' || !jwtSecret)
    throw new MedusaError(MedusaError.Types.UNEXPECTED_STATE, 'Server misconfigured.');
  res.json({ token: signPhoneProof(jwtSecret, phone, purpose) });
}

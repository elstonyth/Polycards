import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import {
  E164_RE,
  checkPhoneOtpCode,
  isPhoneOtpPurpose,
  signPhoneProof,
} from '../../../../utils/phone-verification';

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

  const { jwtSecret } = req.scope.resolve('configModule').projectConfig.http;
  // jwtSecret is typed `Secret` (string | Buffer | ...) by the framework;
  // signPhoneProof's HMAC needs a plain string, so a non-string secret is
  // treated the same as unconfigured.
  if (typeof jwtSecret !== 'string' || !jwtSecret)
    throw new MedusaError(MedusaError.Types.UNEXPECTED_STATE, 'Server misconfigured.');
  res.json({ token: signPhoneProof(jwtSecret, phone, purpose) });
}

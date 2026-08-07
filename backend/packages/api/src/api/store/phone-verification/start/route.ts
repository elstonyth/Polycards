import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { MedusaError, Modules } from '@medusajs/framework/utils';
import type { ICustomerModuleService } from '@medusajs/framework/types';
import {
  E164_RE,
  isAllowedSmsDestination,
  isPhoneOtpPurpose,
  sendPhoneOtp,
} from '../../../../utils/phone-verification';

// Public: sends (or dev-logs) an OTP for one of the three phone flows. The
// response is ALWAYS the generic { ok: true } — whether the phone belongs to
// an account is never disclosed here. SMS-pumping protection is layered:
// the phone-otp-start IP limiter (middlewares.ts), Twilio Verify's own
// per-number caps, and — for password-reset — no SMS at all unless exactly
// one registered account carries the phone (a pumping run would otherwise
// use the reset flow to text arbitrary numbers on our bill).
type Body = { phone?: unknown; purpose?: unknown };

// `phone` isn't declared on FilterableCustomerProps (only has_account is) —
// same cast pattern as findCustomerByHandle (utils/customer-by-handle.ts).
type CustomerFilters = Parameters<ICustomerModuleService['listCustomers']>[0];

export async function POST(
  req: MedusaRequest<Body>,
  res: MedusaResponse,
): Promise<void> {
  const { phone, purpose } = req.body ?? {};
  if (typeof phone !== 'string' || !E164_RE.test(phone))
    throw new MedusaError(MedusaError.Types.INVALID_DATA, 'Invalid phone number.');
  if (!isPhoneOtpPurpose(purpose))
    throw new MedusaError(MedusaError.Types.INVALID_DATA, 'Invalid purpose.');

  const logger = req.scope.resolve('logger') as { warn: (msg: string) => void };

  if (!isAllowedSmsDestination(process.env, phone)) {
    // Deliberately the SAME generic { ok: true } as the password-reset branch
    // below — a distinct error would make this a "which countries work" probe
    // and add a second response shape to a route whose whole contract is that
    // it never discloses what it did. Checked BEFORE the customer lookup so a
    // pumping run costs no query either.
    //
    // Log the calling-code prefix ONLY, never `phone`: at most three digits,
    // which is nobody's dialable number, and enough to see a pumping attempt
    // in the logs. Same PII rule as the Twilio error-code logging above.
    logger.warn(
      `[phone-otp] refused send to unserved destination ${phone.slice(0, 4)}`,
    );
    res.json({ ok: true });
    return;
  }

  if (purpose === 'password-reset') {
    const customerService: ICustomerModuleService = req.scope.resolve(Modules.CUSTOMER);
    const matches = await customerService.listCustomers(
      { phone, has_account: true } as unknown as CustomerFilters,
      { select: ['id'], take: 2 },
    );
    if (matches.length !== 1) {
      // Zero matches: don't text strangers. Two+: ambiguous, the check step
      // would refuse anyway. Same 200 either way — no oracle. Timing skew vs
      // the Twilio call exists; accepted (the email flow has the same shape:
      // core 201s unknown emails without sending).
      res.json({ ok: true });
      return;
    }
  }

  await sendPhoneOtp(process.env, logger, phone);
  res.json({ ok: true });
}

import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { MedusaError, Modules } from '@medusajs/framework/utils';
import type { ICustomerModuleService } from '@medusajs/framework/types';
import {
  E164_RE,
  isAllowedSmsDestination,
  isPhoneOtpPurpose,
  sendPhoneOtp,
  unresolvableSmsCountries,
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

  // password-reset is EXEMPT, and deliberately so: the branch below refuses to
  // send unless exactly ONE registered account carries this phone, so that
  // purpose can only ever text a number already on file. It is not a pumping
  // vector — the account match IS its destination bound. Adding a second bound
  // there would only lock existing customers whose stored number predates this
  // allowlist out of account recovery, buying no security.
  //
  // signup and phone-change have no such bound: they text an ARBITRARY
  // caller-supplied number with no lookup at all. That is the toll-fraud
  // vector, and this is its ceiling.
  if (purpose !== 'password-reset' && !isAllowedSmsDestination(process.env, phone)) {
    // Deliberately the SAME generic { ok: true } as the password-reset branch
    // below — a distinct error would make this a "which countries work" probe
    // and add a second response shape to a route whose whole contract is that
    // it never discloses what it did. Checked BEFORE the customer lookup so a
    // pumping run costs no query either.
    //
    // Log the leading `+` and three digits ONLY, never `phone`. That covers
    // every calling code (max three digits) and can carry at most a couple of
    // subscriber digits — enough to identify the destination region in a
    // pumping attempt, far short of a dialable number. Same PII rule as the
    // Twilio error-code logging in sendPhoneOtp.
    logger.warn(
      `[phone-otp] refused send to unserved destination ${phone.slice(0, 4)}`,
    );
    // A misconfigured allowlist refuses EVERYTHING, +60 included, and looks
    // exactly like a Twilio outage. Name the dead ISO codes next to the
    // refusal they caused. Emitted per refusal rather than once per process:
    // no module state to get stale or leak between tests, the sitewide IP
    // limiter already caps the volume, and during such an outage this is the
    // line the operator needs in the window they are actually staring at.
    const dead = unresolvableSmsCountries(process.env);
    if (dead.length)
      logger.warn(
        `[phone-otp] ALLOWED_SMS_COUNTRIES lists ISO codes with no dialling-code row: ${dead.join(', ')}`,
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
      //
      // The identical 200 is the ANTI-ENUMERATION property and stays: a
      // distinct status, body, or error message here would turn this route into
      // a "does this number have an account" oracle. What was missing is not a
      // different response but DIAGNOSABILITY — a duplicate-phone account can
      // never complete phone recovery (the check step 400s on a multi-match)
      // and until now nothing recorded that the dead end had been reached.
      //
      // Count ONLY, never `phone`: the number is PII and this log is not the
      // place for it. The count is what support needs — 0 means "no account on
      // that number", 2 means "duplicate rows, fix the data".
      logger.warn(
        `[phone-otp] password-reset start matched ${matches.length} accounts — no SMS sent`,
      );
      res.json({ ok: true });
      return;
    }
  }

  // purpose is validated above; it selects the Verify template so the SMS
  // names the flow the code is for.
  await sendPhoneOtp(process.env, logger, phone, purpose);
  res.json({ ok: true });
}

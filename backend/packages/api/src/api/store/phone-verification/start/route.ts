import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { MedusaError, Modules } from '@medusajs/framework/utils';
import type { ICustomerModuleService } from '@medusajs/framework/types';
import {
  E164_RE,
  cancelPhoneOtp,
  isAllowedSmsDestination,
  isCallFirstNetwork,
  isDevOrTest,
  isPhoneOtpChannel,
  isPhoneOtpPurpose,
  sendPhoneOtp,
  unresolvableSmsCountries,
} from '../../../../utils/phone-verification';
import { consumeOtpSendBudget } from '../../../utils/rate-limit';
import {
  holdStart,
  outranks,
  pendingCode,
  type PendingCode,
  type StartHold,
} from '../../../utils/otp-purpose';
import { alertOps } from '../../../../modules/packs/ops-alert';

// Public: sends (or dev-logs) an OTP for one of the three phone flows. The
// success includes only the delivery channel — whether the phone belongs to
// an account is never disclosed here. SMS-pumping protection is layered:
// the Turnstile human check (utils/turnstile-guard.ts, runs first), the
// phone-otp-start IP limiter (middlewares.ts), Twilio Verify's own
// per-number caps, and — for password-reset — no SMS at all unless exactly
// one registered account carries the phone (a pumping run would otherwise
// use the reset flow to text arbitrary numbers on our bill).
// `channel` is optional and defaults to SMS; 'call' is the voice fallback
// (see PHONE_OTP_CHANNELS). Validated here so an unknown value never reaches
// Twilio, whose 400 body would echo the number.
type Body = { phone?: unknown; purpose?: unknown; channel?: unknown };

// `phone` isn't declared on FilterableCustomerProps (only has_account is) —
// same cast pattern as findCustomerByHandle (utils/customer-by-metadata.ts).
type CustomerFilters = Parameters<ICustomerModuleService['listCustomers']>[0];

export async function POST(
  req: MedusaRequest<Body>,
  res: MedusaResponse,
): Promise<void> {
  const { phone, purpose, channel: rawChannel } = req.body ?? {};
  if (typeof phone !== 'string' || !E164_RE.test(phone))
    throw new MedusaError(MedusaError.Types.INVALID_DATA, 'Invalid phone number.');
  if (!isPhoneOtpPurpose(purpose))
    throw new MedusaError(MedusaError.Types.INVALID_DATA, 'Invalid purpose.');
  const channel = rawChannel === undefined ? 'sms' : rawChannel;
  if (!isPhoneOtpChannel(channel))
    throw new MedusaError(MedusaError.Types.INVALID_DATA, 'Invalid channel.');
  // The budget may swap an SMS for a call (consumeOtpSendBudget); `via` is
  // what actually goes out. It is decided per number and budget, never per
  // account, so it reveals nothing about whether this number has one.
  let via = channel;

  const logger = req.scope.resolve('logger') as { warn: (msg: string) => void };

  // Charge every valid attempt before account-sensitive branches. Otherwise a
  // reset followed by signup reveals account existence through cooldown/call
  // quota state. This is a conservative request ceiling, not a billing ledger.
  if (!isDevOrTest(process.env)) {
    // Networks that lose SMS (Maxis) get their first code by call. The
    // budget decides whether to pay for the lookup (at most once per number
    // per code lifetime), before anything account-dependent. Password reset
    // is exempt: its SMS carries the per-purpose template's PASSWORD RESET
    // warning (otpTemplateSid), which a call cannot, and the exemption rides
    // on the caller's purpose, never on the account match.
    const isCallFirst =
      purpose === 'password-reset' ? undefined : () => isCallFirstNetwork(process.env, logger, phone);
    const budget = await consumeOtpSendBudget(phone, channel, Date.now(), isCallFirst);
    if (!budget.allowed) {
      if (budget.sitewide) void alertOps(
        req.scope,
        'phone-otp-budget',
        'Phone-OTP sitewide send or call budget exhausted. Check Twilio traffic before raising PHONE_OTP_GLOBAL_HOURLY_LIMIT / _DAILY_LIMIT (SMS) or PHONE_OTP_CALL_HOURLY_LIMIT / _DAILY_LIMIT (calls).',
        { muteMs: 60 * 60_000 },
      );
      const retry = Math.max(1, Math.ceil(budget.retryAfterMs / 1000));
      res.status(429).set('Retry-After', String(retry)).json({
        type: 'rate_limit_exceeded',
        message: `Too many code requests. Try again in ${retry}s.`,
      });
      return;
    }
    via = budget.channel;
  }
  const response = { ok: true, channel: via };

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
    res.json(response);
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
      res.json(response);
      return;
    }
  }

  // purpose is validated above; it selects the Verify template so the SMS
  // names the flow the code is for.
  // One start per number at a time (utils/otp-purpose.ts holdStart). Every
  // way this start does not send answers like a sent one, so none of them
  // says anything about the number.
  let hold: StartHold | null;
  try {
    hold = await holdStart(phone);
  } catch {
    logger.warn('[phone-otp] could not hold the number for a start');
    hold = null;
  }
  if (!hold) {
    res.json(response);
    return;
  }
  try {
    // A code pending for another flow dies first: Twilio would resend that
    // same code under this flow's wording. One that outranks this flow is
    // left alone, and so is everything when it cannot be read or cancelled:
    // then nothing is sent.
    let pending: PendingCode | null;
    try {
      pending = await pendingCode(phone);
    } catch {
      logger.warn('[phone-otp] could not read the code purpose');
      res.json(response);
      return;
    }
    if (pending && pending.purpose !== purpose) {
      const cancelled =
        !outranks(pending.purpose, purpose) &&
        (pending.sid
          ? await cancelPhoneOtp(process.env, logger, pending.sid)
          : // The dev transport has no verification to cancel; its code is fixed.
            isDevOrTest(process.env));
      if (!cancelled) {
        res.json(response);
        return;
      }
    }
    // A start that stalled past its hold may have been overtaken: it sends
    // nothing, and (below) records nothing.
    if (!(await hold.held())) {
      res.json(response);
      return;
    }
    let sid: string | undefined;
    try {
      sid = await sendPhoneOtp(process.env, logger, phone, purpose, via);
    } catch (error) {
      if (purpose !== 'password-reset') throw error;
      // Provider errors must not reveal whether a reset account exists.
      res.json(response);
      return;
    }
    // Recorded only while still held, in one step with that check.
    // Unrecorded, the check is refused, so a store blip costs a retry.
    let recorded: boolean | null;
    try {
      recorded = await hold.note(purpose, sid);
    } catch {
      logger.warn('[phone-otp] could not record the code purpose');
      recorded = null;
    }
    if (recorded === false) {
      // Overtaken between the hold check and the send: another start for
      // this number has since recorded its own code, and Twilio may have
      // resent that same code under this flow's wording. Cancel what was
      // sent, so the code works for no flow; the other start's owner asks
      // again.
      logger.warn('[phone-otp] start overtaken; cancelling the code it sent');
      if (sid) await cancelPhoneOtp(process.env, logger, sid);
    }
    res.json(response);
  } finally {
    await hold.release();
  }
}

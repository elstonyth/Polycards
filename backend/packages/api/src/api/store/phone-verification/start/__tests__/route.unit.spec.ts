import { POST as startVerification } from '../route';
import * as phoneUtils from '../../../../../utils/phone-verification';

// Only the transport is mocked. `isAllowedSmsDestination` stays REAL — it is the
// thing under test here, and stubbing it is exactly the red-green probe (see the
// plan's test plan: stubbing it true must make the refusal case fail).
jest.mock('../../../../../utils/phone-verification', () => ({
  ...jest.requireActual('../../../../../utils/phone-verification'),
  sendPhoneOtp: jest.fn(async () => undefined),
}));

const sendPhoneOtp = phoneUtils.sendPhoneOtp as jest.Mock;

// Assert on the CALL COUNT, not on the mock itself. The route passes
// `process.env` as sendPhoneOtp's first argument, so a failing
// `expect(sendPhoneOtp).not.toHaveBeenCalled()` pretty-prints every recorded
// argument — i.e. the entire environment, API keys included — into the CI log.
// A number can't leak anything.
const sendCount = () => sendPhoneOtp.mock.calls.length;

const MY = '+60107667787';
const GB = '+442079460958';

const mkRes = () => {
  const out: { body?: unknown } = {};
  return { res: { json: (b: unknown) => (out.body = b) } as never, out };
};

const warn = jest.fn();
// `matches` is what listCustomers returns for the password-reset lookup: one
// row means "exactly one account carries this phone", the only case that sends.
const mkReq = (phone: string, purpose = 'signup', matches: unknown[] = [{ id: 'cus_1' }]) =>
  ({
    body: { phone, purpose },
    scope: {
      resolve: (key: string) =>
        key === 'logger'
          ? { warn }
          : { listCustomers: jest.fn(async () => matches) },
    },
  }) as never;

beforeEach(() => {
  warn.mockReset();
  sendPhoneOtp.mockClear();
});

describe('POST /store/phone-verification/start — destination allowlist', () => {
  it('sends to a served destination', async () => {
    const { res, out } = mkRes();
    await startVerification(mkReq(MY), res);
    expect(sendCount()).toBe(1);
    expect(out.body).toEqual({ ok: true });
  });

  // The whole point: this route is unauthenticated and every call bills an SMS.
  it('refuses an unserved destination without sending, and says nothing about it', async () => {
    const { res, out } = mkRes();
    await startVerification(mkReq(GB), res);

    expect(sendCount()).toBe(0);
    // Byte-identical to the success shape above and to the silent
    // password-reset branch — a distinct error would be a country-probe oracle.
    expect(out.body).toEqual({ ok: true });
  });

  it('logs the calling-code prefix only, never the number', async () => {
    await startVerification(mkReq(GB), mkRes().res);
    const line = warn.mock.calls[0][0] as string;
    expect(line).toContain('+44');
    expect(line).not.toContain(GB);
  });

  // password-reset is exempt: it already refuses unless exactly one registered
  // account carries the number, so it can only text a phone already on file.
  // Customers who registered a non-MY number before the allowlist existed must
  // keep being able to recover their account.
  it('still sends a password reset to an unserved destination on file', async () => {
    const { res, out } = mkRes();
    await startVerification(mkReq(GB, 'password-reset'), res);
    expect(sendCount()).toBe(1);
    expect(out.body).toEqual({ ok: true });
  });

  // …but the exemption rides on the account match, not on the purpose string:
  // an unknown number gets the pre-existing silent no-send either way.
  it('does not send a password reset to a number on no account', async () => {
    const { res, out } = mkRes();
    await startVerification(mkReq(GB, 'password-reset', []), res);
    expect(sendCount()).toBe(0);
    expect(out.body).toEqual({ ok: true });
  });

  // A configuration that refuses EVERY destination (including the default) is
  // the failure mode most likely to be misread as a Twilio outage, so it must
  // name itself in the log rather than just going quiet.
  it('names dead ISO codes in the log when the allowlist resolves to nothing', async () => {
    const prev = process.env.ALLOWED_SMS_COUNTRIES;
    process.env.ALLOWED_SMS_COUNTRIES = 'SG';
    try {
      await startVerification(mkReq(MY), mkRes().res);
      expect(sendCount()).toBe(0); // even the default destination is dead now
      const lines = warn.mock.calls.map((c) => c[0] as string);
      expect(lines.some((l) => l.includes('ALLOWED_SMS_COUNTRIES') && l.includes('SG'))).toBe(
        true,
      );
    } finally {
      if (prev === undefined) delete process.env.ALLOWED_SMS_COUNTRIES;
      else process.env.ALLOWED_SMS_COUNTRIES = prev;
    }
  });

  it('stays quiet about ISO codes when the allowlist is sound', async () => {
    await startVerification(mkReq(GB), mkRes().res);
    const lines = warn.mock.calls.map((c) => c[0] as string);
    expect(lines.some((l) => l.includes('ALLOWED_SMS_COUNTRIES'))).toBe(false);
  });
});

/**
 * The duplicate-phone dead end. An account whose phone matches zero or two-plus
 * rows can never complete phone recovery — the check step refuses a multi-match
 * outright — and until now the route said "we'll text you a code" and recorded
 * nothing, so support had no way to tell that story apart from a lost SMS.
 *
 * The identical 200 is the ANTI-ENUMERATION property and is asserted below in
 * all three branches precisely so nobody "helpfully" differentiates it. The fix
 * is a log line, not a different response.
 */
describe('POST /store/phone-verification/start — duplicate-phone diagnosability', () => {
  const line = () => warn.mock.calls.map((c) => String(c[0])).join('\n');

  it('zero matches: identical 200, no SMS, and a warn carrying the count', async () => {
    const { res, out } = mkRes();
    await startVerification(mkReq(MY, 'password-reset', []), res);
    expect(sendCount()).toBe(0);
    expect(out.body).toEqual({ ok: true });
    expect(line()).toContain('matched 0 accounts');
  });

  it('two matches: byte-identical response, warn with count 2', async () => {
    const { res, out } = mkRes();
    await startVerification(
      mkReq(MY, 'password-reset', [{ id: 'cus_1' }, { id: 'cus_2' }]),
      res,
    );
    expect(sendCount()).toBe(0);
    // Same object as the zero-match and the success branch — a distinct status,
    // body or message here is a phone-enumeration oracle.
    expect(out.body).toEqual({ ok: true });
    expect(line()).toContain('matched 2 accounts');
  });

  it('exactly one match: SMS sent and NOTHING logged (no happy-path noise)', async () => {
    const { res, out } = mkRes();
    await startVerification(mkReq(MY, 'password-reset', [{ id: 'cus_1' }]), res);
    expect(sendCount()).toBe(1);
    expect(out.body).toEqual({ ok: true });
    expect(warn).not.toHaveBeenCalled();
  });

  // The PII rule, asserted across EVERY warn call rather than calls[0] — an
  // index-based check silently stops covering a branch as soon as call order
  // shifts. A phone number in a log line is the leak this guards.
  it.each([
    ['zero matches', [] as unknown[]],
    ['two matches', [{ id: 'cus_1' }, { id: 'cus_2' }]],
  ])('never logs the phone number itself (%s)', async (_case, matches) => {
    await startVerification(
      mkReq(MY, 'password-reset', matches),
      mkRes().res,
    );
    expect(warn).toHaveBeenCalled();
    expect(line()).not.toContain(MY);
    // Not even the subscriber part on its own — '+60' as a calling code is
    // fine, the dialable remainder is not.
    expect(line()).not.toContain(MY.slice(3));
  });
});

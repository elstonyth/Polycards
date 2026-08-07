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
});

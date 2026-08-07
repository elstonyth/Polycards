import { MedusaError, Modules } from '@medusajs/framework/utils';
import { POST } from '../route';
import { signPhoneProof } from '../../../../../utils/phone-verification';
import { PACKS_MODULE } from '../../../../../modules/packs';
import { PHONE_CHANGED_TEMPLATE } from '../../../../../modules/resend/templates';

// The re-auth gate on POST /store/phone-verification/change. Structural pattern
// from store/credits/deposit/__tests__/route.unit.spec.ts: a fake `req` from a
// mkReq helper, and process.env restored in afterEach.
//
// Proof tokens are MINTED WITH THE REAL signPhoneProof rather than mocked. The
// gate's Google-only branch compares a second proof against the customer's
// CURRENT phone, so a mocked verifier would let that comparison pass on a token
// that the real HMAC would reject — the exact class of bug these cases exist to
// catch.
//
// SECRET HYGIENE: assertions on the auth mock use `.mock.calls.length`, never
// `expect(mock).not.toHaveBeenCalled()`. The latter pretty-prints recorded
// arguments on failure, and `authenticate` is called with the customer's
// plaintext password. This is a public repo — a failing assertion must not put
// credentials in a CI log.

const SECRET = 'unit-test-jwt-secret';
const EMAIL = 'owner@test.dev';
const OLD_PHONE = '+60107667781';
const NEW_PHONE = '+60107667790';
const CUSTOMER_ID = 'cus_1';
const PASSWORD = 'correct horse battery staple';

const newPhoneProof = () => signPhoneProof(SECRET, NEW_PHONE, 'phone-change');
const oldPhoneProof = () => signPhoneProof(SECRET, OLD_PHONE, 'phone-change');

// Per-test fixture state, reset in beforeEach.
let customerRow: { id: string; email: unknown; phone: string | null };
let emailpassIdentities: unknown[];
let passwordIsCorrect: boolean;

const retrieveCustomer = jest.fn(async () => customerRow);
const listCustomers = jest.fn(async () => [] as { id: string }[]);
const updateCustomers = jest.fn(async () => undefined);
const listAuthIdentities = jest.fn(async () => emailpassIdentities);
// Mirrors the real contract read from
// node_modules/@medusajs/auth-emailpass/dist/services/emailpass.js:84-97 and
// @medusajs/auth/dist/services/auth-module.js:73-80: a wrong password RETURNS
// a truthy `{ success: false, error }` object, it never throws.
const authenticate = jest.fn(async () =>
  passwordIsCorrect
    ? { success: true, authIdentity: { id: 'authid_1' } }
    : { success: false, error: 'Invalid email or password' },
);
const markPhoneVerified = jest.fn(async () => undefined);
// Typed parameter, not `async () => []`: jest infers an empty args tuple from a
// zero-arg factory, and `createNotifications.mock.calls[0][0]` below then fails
// to compile (TS2493).
const createNotifications = jest.fn(
  async (_payload: Record<string, unknown>) => [],
);
const warn = jest.fn();

const scope = {
  resolve: (key: string) => {
    if (key === 'configModule')
      return { projectConfig: { http: { jwtSecret: SECRET } } };
    if (key === Modules.CUSTOMER)
      return { retrieveCustomer, listCustomers, updateCustomers };
    if (key === Modules.AUTH) return { listAuthIdentities, authenticate };
    if (key === PACKS_MODULE) return { markPhoneVerified };
    if (key === Modules.NOTIFICATION) return { createNotifications };
    if (key === 'logger') return { warn };
    throw new Error(`unit scope: unexpected resolve('${key}')`);
  },
};

const mkReq = (body: Record<string, unknown>) =>
  ({ auth_context: { actor_id: CUSTOMER_ID }, body, scope }) as never;

const mkRes = () => ({ json: jest.fn() });

/** Assert-and-return the rejection. A bare `rejects.toThrow` would also pass if
 *  POST threw for an unrelated reason, and a resolved call must fail loudly
 *  rather than silently skip the assertions that follow. */
const rejection = async (promise: Promise<void>): Promise<MedusaError> => {
  try {
    await promise;
  } catch (e) {
    return e as MedusaError;
  }
  throw new Error('expected POST to reject, but it resolved');
};

const ORIGINAL_ENV = {
  RESEND_API_KEY: process.env.RESEND_API_KEY,
  RESEND_FROM_EMAIL: process.env.RESEND_FROM_EMAIL,
};

beforeEach(() => {
  jest.clearAllMocks();
  customerRow = { id: CUSTOMER_ID, email: EMAIL, phone: OLD_PHONE };
  emailpassIdentities = [{ id: 'authid_1' }];
  passwordIsCorrect = true;
  // The route skips the send entirely unless Resend is configured, so the
  // notification cases would assert nothing without these.
  process.env.RESEND_API_KEY = 'test-key';
  process.env.RESEND_FROM_EMAIL = 'no-reply@test.dev';
});

// Process-wide: leaving them set leaks into whatever runs next.
afterEach(() => {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('POST /store/phone-verification/change — emailpass accounts', () => {
  it('updates the phone and emails the account when the password is correct', async () => {
    const res = mkRes();
    await POST(
      mkReq({ phone: NEW_PHONE, token: newPhoneProof(), password: PASSWORD }),
      res as never,
    );

    expect(updateCustomers.mock.calls).toEqual([
      [CUSTOMER_ID, { phone: NEW_PHONE }],
    ]);
    expect(markPhoneVerified.mock.calls.length).toBe(1);
    expect(res.json).toHaveBeenCalledWith({
      customer: { id: CUSTOMER_ID, phone: NEW_PHONE },
    });

    // Goes to the EMAIL, and carries only the last 4 digits of either number.
    expect(createNotifications.mock.calls[0][0]).toEqual({
      to: EMAIL,
      channel: 'email',
      template: PHONE_CHANGED_TEMPLATE,
      data: { old_phone_masked: '••••7781', new_phone_masked: '••••7790' },
    });
  });

  // THE anti-regression case: revert the gate and this one must go red.
  it('rejects a wrong password and leaves the phone untouched', async () => {
    passwordIsCorrect = false;
    const err = await rejection(
      POST(
        mkReq({
          phone: NEW_PHONE,
          token: newPhoneProof(),
          password: 'not the password',
        }),
        mkRes() as never,
      ),
    );

    expect(err.type).toBe(MedusaError.Types.UNAUTHORIZED);
    expect(err.message).toBe(
      'Enter your current password to change your phone number.',
    );
    // `.mock.calls.length`, not `.not.toHaveBeenCalled()` — see the secret
    // hygiene note at the top of this file.
    expect(updateCustomers.mock.calls.length).toBe(0);
    expect(markPhoneVerified.mock.calls.length).toBe(0);
    expect(createNotifications.mock.calls.length).toBe(0);
  });

  it('rejects a body with no password at all, without consulting the auth module', async () => {
    const err = await rejection(
      POST(
        mkReq({ phone: NEW_PHONE, token: newPhoneProof() }),
        mkRes() as never,
      ),
    );

    expect(err.type).toBe(MedusaError.Types.UNAUTHORIZED);
    expect(updateCustomers.mock.calls.length).toBe(0);
    expect(authenticate.mock.calls.length).toBe(0);
  });

  // The password branch is chosen by "has an emailpass identity", NOT by "has a
  // phone already". An emailpass account adding its FIRST phone is still a
  // takeover vector — the attacker's number becomes the recovery number and
  // password-reset/route.ts hands over a reset token for the real password.
  it('still requires the password when the account has no phone yet', async () => {
    customerRow = { id: CUSTOMER_ID, email: EMAIL, phone: null };
    const err = await rejection(
      POST(
        mkReq({ phone: NEW_PHONE, token: newPhoneProof() }),
        mkRes() as never,
      ),
    );

    expect(err.type).toBe(MedusaError.Types.UNAUTHORIZED);
    expect(updateCustomers.mock.calls.length).toBe(0);
  });

  // ORDERING, not outcome. The re-auth gate sits AFTER the new-number proof
  // check on purpose (route.ts documents it): a caller holding no valid proof
  // is refused before any password is examined, so this route cannot be used as
  // a password oracle by someone who never passed the OTP step.
  //
  // Every OTHER case in this file passes with the gate hoisted above the proof
  // check — the success paths all carry valid proofs, and the UNAUTHORIZED
  // cases never exercise a BAD one. This case is the only thing pinning the
  // order. Mirror of password-reset/__tests__/route.unit.spec.ts, which pins
  // its own gate the same way. Hoist the gate and this goes red twice: the
  // error becomes UNAUTHORIZED, and authenticate gets called.
  it('answers a bad proof with the proof error, without consulting the auth module', async () => {
    const err = await rejection(
      POST(
        mkReq({
          phone: NEW_PHONE,
          // Well-formed, correctly signed, correct phone — WRONG purpose, so
          // verifyPhoneProof rejects it. A real password rides along, which is
          // what makes this an oracle test rather than a duplicate of the
          // missing-password case above.
          token: signPhoneProof(SECRET, NEW_PHONE, 'password-reset'),
          password: PASSWORD,
        }),
        mkRes() as never,
      ),
    );

    expect(err.type).toBe(MedusaError.Types.INVALID_DATA);
    expect(err.message).toBe('Phone verification required.');
    // THE ordering assertion: a valid password was in the body and the auth
    // module never saw it. `.mock.calls.length`, not `.not.toHaveBeenCalled()`
    // — see the secret hygiene note at the top of this file.
    expect(authenticate.mock.calls.length).toBe(0);
    expect(updateCustomers.mock.calls.length).toBe(0);
  });

  it('refuses when the customer row has no readable email', async () => {
    customerRow = { id: CUSTOMER_ID, email: null, phone: OLD_PHONE };
    const err = await rejection(
      POST(
        mkReq({ phone: NEW_PHONE, token: newPhoneProof(), password: PASSWORD }),
        mkRes() as never,
      ),
    );

    expect(err.type).toBe(MedusaError.Types.UNEXPECTED_STATE);
    expect(updateCustomers.mock.calls.length).toBe(0);
  });
});

describe('POST /store/phone-verification/change — Google-only accounts', () => {
  beforeEach(() => {
    emailpassIdentities = [];
  });

  it('rejects a phone move with no proof for the CURRENT number', async () => {
    const err = await rejection(
      POST(
        mkReq({ phone: NEW_PHONE, token: newPhoneProof() }),
        mkRes() as never,
      ),
    );

    expect(err.type).toBe(MedusaError.Types.UNAUTHORIZED);
    expect(err.message).toBe('Verify your current phone number to change it.');
    expect(updateCustomers.mock.calls.length).toBe(0);
  });

  it('rejects an old_phone_token minted for some other number', async () => {
    const err = await rejection(
      POST(
        mkReq({
          phone: NEW_PHONE,
          token: newPhoneProof(),
          // A proof for the number they are moving TO is not a proof of the
          // number they are moving FROM — replaying the first token must fail.
          old_phone_token: newPhoneProof(),
        }),
        mkRes() as never,
      ),
    );

    expect(err.type).toBe(MedusaError.Types.UNAUTHORIZED);
    expect(updateCustomers.mock.calls.length).toBe(0);
  });

  it('accepts a valid old_phone_token for the current number', async () => {
    const res = mkRes();
    await POST(
      mkReq({
        phone: NEW_PHONE,
        token: newPhoneProof(),
        old_phone_token: oldPhoneProof(),
      }),
      res as never,
    );

    expect(updateCustomers.mock.calls).toEqual([
      [CUSTOMER_ID, { phone: NEW_PHONE }],
    ]);
    expect(res.json).toHaveBeenCalled();
    // No password branch was taken.
    expect(authenticate.mock.calls.length).toBe(0);
  });

  // The one path that keeps working exactly as it did before this gate.
  it('accepts first-time verification with only the new number proof', async () => {
    customerRow = { id: CUSTOMER_ID, email: EMAIL, phone: null };
    const res = mkRes();
    await POST(
      mkReq({ phone: NEW_PHONE, token: newPhoneProof() }),
      res as never,
    );

    expect(updateCustomers.mock.calls).toEqual([
      [CUSTOMER_ID, { phone: NEW_PHONE }],
    ]);
    expect(markPhoneVerified.mock.calls.length).toBe(1);
    expect(res.json).toHaveBeenCalled();
    // Nothing changed, so nothing to warn about.
    expect(createNotifications.mock.calls.length).toBe(0);
  });
});

describe('POST /store/phone-verification/change — notification is best-effort', () => {
  it('still answers 200 when the email send fails', async () => {
    createNotifications.mockRejectedValueOnce(new Error('resend is down'));
    const res = mkRes();

    await POST(
      mkReq({ phone: NEW_PHONE, token: newPhoneProof(), password: PASSWORD }),
      res as never,
    );

    // The phone write already committed — a dropped notice must not undo it or
    // report failure for something that succeeded.
    expect(updateCustomers.mock.calls.length).toBe(1);
    expect(res.json).toHaveBeenCalledWith({
      customer: { id: CUSTOMER_ID, phone: NEW_PHONE },
    });
    expect(warn.mock.calls.length).toBe(1);
    // PRIVACY: the warn names the customer id and must not carry the numbers or
    // the email address.
    const logged = String(warn.mock.calls[0][0]);
    expect(logged).toContain(CUSTOMER_ID);
    expect(logged).not.toContain(OLD_PHONE);
    expect(logged).not.toContain(NEW_PHONE);
    expect(logged).not.toContain(EMAIL);
  });
});

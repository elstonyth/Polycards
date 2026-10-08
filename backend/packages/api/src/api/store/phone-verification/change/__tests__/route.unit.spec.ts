import { MedusaError, Modules } from '@medusajs/framework/utils';
import { POST } from '../route';
import { signPhoneProof } from '../../../../../utils/phone-verification';
import { PACKS_MODULE } from '../../../../../modules/packs';

// The one-proof-one-account claim (Redis SET NX in production) as an in-memory
// set: `mock`-prefixed so jest's hoisted factory may close over them.
const mockClaimed = new Set<string>();
let mockClaimFails = false;
jest.mock('../../../../utils/rate-limit', () => ({
  warmSignupProofClaims: () => ({
    claim: async (key: string) => {
      if (mockClaimFails) throw new Error('redis down');
      if (mockClaimed.has(key)) return false;
      mockClaimed.add(key);
      return true;
    },
    release: async (key: string) => {
      mockClaimed.delete(key);
    },
  }),
}));

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
type Identity = {
  app_metadata: { customer_id?: string };
  provider_identities: { provider: string; entity_id: string }[];
};
let identities: Identity[];
let passwordIsCorrect: boolean;

const linked = (provider: string, entity_id: string): Identity => ({
  app_metadata: { customer_id: CUSTOMER_ID },
  provider_identities: [{ provider, entity_id }],
});
// An emailpass identity registered with the account's email but linked to NO
// customer — what a failed email signup on a Google account's address leaves.
const orphanEmailpass = (): Identity => ({
  app_metadata: {},
  provider_identities: [{ provider: 'emailpass', entity_id: EMAIL }],
});

const retrieveCustomer = jest.fn(async () => customerRow);
const listCustomers = jest.fn(async () => [] as { id: string }[]);
const updateCustomers = jest.fn(async () => undefined);
// Filter-aware like the real query: only identities LINKED to the customer.
const listAuthIdentities = jest.fn(
  async (filter: { app_metadata?: { customer_id?: string } }) =>
    identities.filter(
      (i) => i.app_metadata.customer_id === filter.app_metadata?.customer_id,
    ),
);
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
// Phone lock (spec 2026-10-06): an account that already verified a number is
// refused before anything else runs. Default: not yet verified.
let phoneVerified = false;
const isPhoneVerified = jest.fn(async () => phoneVerified);
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
    if (key === PACKS_MODULE) return { markPhoneVerified, isPhoneVerified };
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
  identities = [linked('emailpass', EMAIL)];
  passwordIsCorrect = true;
  phoneVerified = false;
  mockClaimed.clear();
  mockClaimFails = false;
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

// The default fixture is a LEGACY account: a phone on file (OLD_PHONE) that
// was never verified. Since the phone lock (spec 2026-10-06) such an account
// may only verify THAT number in place, so the re-auth cases below verify
// OLD_PHONE; the cases that move to NEW_PHONE start from an account with no
// phone at all (a first add).
describe('POST /store/phone-verification/change — emailpass accounts', () => {
  it('verifies the number on file in place when the password is correct', async () => {
    const res = mkRes();
    await POST(
      mkReq({ phone: OLD_PHONE, token: oldPhoneProof(), password: PASSWORD }),
      res as never,
    );

    expect(updateCustomers.mock.calls).toEqual([
      [CUSTOMER_ID, { phone: OLD_PHONE }],
    ]);
    expect(markPhoneVerified.mock.calls.length).toBe(1);
    expect(res.json).toHaveBeenCalledWith({
      customer: { id: CUSTOMER_ID, phone: OLD_PHONE },
    });
    // Nothing moved, so nothing to warn about.
    expect(createNotifications.mock.calls.length).toBe(0);
  });

  // THE anti-regression case: revert the gate and this one must go red.
  it('rejects a wrong password and leaves the phone untouched', async () => {
    passwordIsCorrect = false;
    const err = await rejection(
      POST(
        mkReq({
          phone: OLD_PHONE,
          token: oldPhoneProof(),
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
        mkReq({ phone: OLD_PHONE, token: oldPhoneProof() }),
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
        mkReq({ phone: OLD_PHONE, token: oldPhoneProof(), password: PASSWORD }),
        mkRes() as never,
      ),
    );

    expect(err.type).toBe(MedusaError.Types.UNEXPECTED_STATE);
    expect(updateCustomers.mock.calls.length).toBe(0);
  });
});

describe('POST /store/phone-verification/change — Google-only accounts', () => {
  beforeEach(() => {
    identities = [linked('google', 'g-123')];
  });

  // 2026-09-30: three Google users with an orphan emailpass identity on their
  // email were sent down the password branch — a 401 in a modal with no
  // password field, one SMS per retry, no way out but logging out.
  it('lets a phoneless Google account with an UNLINKED emailpass identity add its first phone', async () => {
    identities = [linked('google', 'g-123'), orphanEmailpass()];
    customerRow = { id: CUSTOMER_ID, email: EMAIL, phone: null };
    const res = mkRes();
    await POST(
      mkReq({ phone: NEW_PHONE, token: newPhoneProof() }),
      res as never,
    );

    expect(updateCustomers.mock.calls).toEqual([
      [CUSTOMER_ID, { phone: NEW_PHONE }],
    ]);
    expect(authenticate.mock.calls.length).toBe(0);
  });

  // The other half of the same bug, and the dangerous one: a session thief who
  // registers the victim's email with a password of their own must NOT get to
  // swap the old-phone proof for that password.
  it('still demands the old-phone proof when an UNLINKED emailpass identity exists, even with its password', async () => {
    identities = [linked('google', 'g-123'), orphanEmailpass()];
    const err = await rejection(
      POST(
        mkReq({ phone: OLD_PHONE, token: oldPhoneProof(), password: PASSWORD }),
        mkRes() as never,
      ),
    );

    expect(err.type).toBe(MedusaError.Types.UNAUTHORIZED);
    expect(err.message).toBe('Verify your current phone number to change it.');
    expect(authenticate.mock.calls.length).toBe(0);
    expect(updateCustomers.mock.calls.length).toBe(0);
  });

  it('rejects an in-place verify with no separate proof for the CURRENT number', async () => {
    const err = await rejection(
      POST(
        mkReq({ phone: OLD_PHONE, token: oldPhoneProof() }),
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
          phone: OLD_PHONE,
          token: oldPhoneProof(),
          // A proof for some OTHER number is not a proof of the one on file.
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
        phone: OLD_PHONE,
        token: oldPhoneProof(),
        old_phone_token: oldPhoneProof(),
      }),
      res as never,
    );

    expect(updateCustomers.mock.calls).toEqual([
      [CUSTOMER_ID, { phone: OLD_PHONE }],
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

describe('POST /store/phone-verification/change — phone lock (spec 2026-10-06)', () => {
  it('refuses an account that already verified a phone, before anything else', async () => {
    phoneVerified = true;
    const err = await rejection(
      POST(
        mkReq({ phone: NEW_PHONE, token: newPhoneProof(), password: PASSWORD }),
        mkRes() as never,
      ),
    );
    expect(err.type).toBe(MedusaError.Types.NOT_ALLOWED);
    expect(err.message).toMatch(/contact customer service/i);
    expect(isPhoneVerified).toHaveBeenCalledWith(CUSTOMER_ID);
    // Nothing past the lock ran: no password check, no write, no stamp.
    // `.mock.calls.length` — see the secret hygiene note at the top.
    expect(authenticate.mock.calls.length).toBe(0);
    expect(updateCustomers.mock.calls.length).toBe(0);
    expect(markPhoneVerified.mock.calls.length).toBe(0);
  });

  // "Old customers cannot change their phone either": a legacy unverified
  // number may be verified in place, never swapped — even with the password
  // and a valid proof for the new number. Refused before the re-auth gate.
  it('refuses swapping an unverified number on file for a different one', async () => {
    const err = await rejection(
      POST(
        mkReq({ phone: NEW_PHONE, token: newPhoneProof(), password: PASSWORD }),
        mkRes() as never,
      ),
    );
    expect(err.type).toBe(MedusaError.Types.NOT_ALLOWED);
    expect(err.message).toMatch(/only verify the number already on your account/i);
    expect(authenticate.mock.calls.length).toBe(0);
    expect(updateCustomers.mock.calls.length).toBe(0);
  });

  it('still lets a never-verified account with no number set its first one', async () => {
    phoneVerified = false;
    customerRow = { id: CUSTOMER_ID, email: EMAIL, phone: null };
    const res = mkRes();
    await POST(
      mkReq({ phone: NEW_PHONE, token: newPhoneProof(), password: PASSWORD }),
      res as never,
    );
    expect(updateCustomers).toHaveBeenCalledWith(CUSTOMER_ID, {
      phone: NEW_PHONE,
    });
    expect(markPhoneVerified).toHaveBeenCalledWith(CUSTOMER_ID);
  });
});

describe('POST /store/phone-verification/change — one proof, one account', () => {
  // The 2026-10-06 review's HIGH: N phoneless accounts firing ONE code at once
  // all saw the number free (assertPhoneUnclaimed is a read) and all landed
  // it, each stamped verified.
  it('refuses a second use of the same proof', async () => {
    customerRow = { id: CUSTOMER_ID, email: EMAIL, phone: null };
    const token = newPhoneProof();
    await POST(
      mkReq({ phone: NEW_PHONE, token, password: PASSWORD }),
      mkRes() as never,
    );

    const err = await rejection(
      POST(
        mkReq({ phone: NEW_PHONE, token, password: PASSWORD }),
        mkRes() as never,
      ),
    );
    // A spent proof reads exactly like a missing or expired one.
    expect(err.type).toBe(MedusaError.Types.INVALID_DATA);
    expect(err.message).toBe('Phone verification required.');
    expect(updateCustomers.mock.calls.length).toBe(1);
  });

  it('gives the proof back when the write is refused, so a retry needs no new code', async () => {
    customerRow = { id: CUSTOMER_ID, email: EMAIL, phone: null };
    const token = newPhoneProof();
    listCustomers.mockResolvedValueOnce([{ id: 'cus_other' }]);
    const first = await rejection(
      POST(
        mkReq({ phone: NEW_PHONE, token, password: PASSWORD }),
        mkRes() as never,
      ),
    );
    expect(first.message).toMatch(/already in use/i);

    const res = mkRes();
    await POST(
      mkReq({ phone: NEW_PHONE, token, password: PASSWORD }),
      res as never,
    );
    expect(updateCustomers.mock.calls).toEqual([
      [CUSTOMER_ID, { phone: NEW_PHONE }],
    ]);
  });

  it('fails closed when the claim store is unreachable', async () => {
    customerRow = { id: CUSTOMER_ID, email: EMAIL, phone: null };
    mockClaimFails = true;
    const err = await rejection(
      POST(
        mkReq({ phone: NEW_PHONE, token: newPhoneProof(), password: PASSWORD }),
        mkRes() as never,
      ),
    );
    expect(err.type).toBe(MedusaError.Types.NOT_ALLOWED);
    expect(updateCustomers.mock.calls.length).toBe(0);
    expect(markPhoneVerified.mock.calls.length).toBe(0);
  });

  // The claim is taken after the re-auth gate: a Google-only account's first
  // attempt, refused for the missing old-number proof, must leave the proof
  // good for the retry that carries both.
  it('does not spend the proof on a request the re-auth gate refuses', async () => {
    identities = [linked('google', 'g-123')];
    const token = oldPhoneProof();
    const refused = await rejection(
      POST(mkReq({ phone: OLD_PHONE, token }), mkRes() as never),
    );
    expect(refused.type).toBe(MedusaError.Types.UNAUTHORIZED);

    await POST(
      mkReq({ phone: OLD_PHONE, token, old_phone_token: oldPhoneProof() }),
      mkRes() as never,
    );
    expect(updateCustomers.mock.calls.length).toBe(1);
  });
});

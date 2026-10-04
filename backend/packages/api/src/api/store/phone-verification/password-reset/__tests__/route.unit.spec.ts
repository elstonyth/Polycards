import { MedusaError, Modules } from '@medusajs/framework/utils';

// The flag gate on POST /store/phone-verification/password-reset. Only the
// Medusa I/O boundary is mocked; the proof primitive is REAL (tokens are minted
// with signPhoneProof), for the reason the change route's spec documents — a
// mocked verifier would let ordering bugs through.
//
// generateResetPasswordTokenWorkflow is the thing that mints the reset token,
// so "no token was generated" is asserted as "the workflow was never
// constructed". A fresh `run` mock per call (same shape as
// api/admin/media/__tests__/bake-slab-rebake.unit.spec.ts) keeps the factory's
// own call count the single source of truth for that.
jest.mock('@medusajs/core-flows', () => ({
  generateResetPasswordTokenWorkflow: jest.fn(() => ({
    run: jest.fn(async () => ({ result: 'reset_token_stub' })),
  })),
}));
// Every account here is in a verification-exempt partner group. The route must
// not consult it — see the exempt case below.
jest.mock('../../../../../modules/packs/group-policy', () => ({
  resolveGroupPolicyForCustomer: jest.fn(async () => ({
    policy: { verification_exempt: true },
  })),
}));

import { generateResetPasswordTokenWorkflow } from '@medusajs/core-flows';
import { POST } from '../route';
import { signPhoneProof } from '../../../../../utils/phone-verification';
import { PACKS_MODULE } from '../../../../../modules/packs';

const workflow = generateResetPasswordTokenWorkflow as unknown as jest.Mock;
/** Call count only — a failing `expect(mock).not.toHaveBeenCalled()`
 *  pretty-prints recorded arguments, and this workflow is invoked with the
 *  app's jwtSecret. This repo is public. */
const mintCount = () => workflow.mock.calls.length;

const SECRET = 'unit-test-jwt-secret';
const PHONE = '+60107667787';
const EMAIL = 'owner@test.dev';

const resetProof = () => signPhoneProof(SECRET, PHONE, 'password-reset');

let customers: { id: string; email: string }[];
const listCustomers = jest.fn(async () => customers);

// customer_account_state.phone_verified_at, as the packs service reads it.
let phoneVerified: boolean;
const isPhoneVerified = jest.fn(async (_customerId: string) => phoneVerified);

type Identity = {
  app_metadata: { customer_id?: string };
  provider_identities: { provider: string; entity_id: string }[];
};
let identities: Identity[];
// Filter-aware like the real query: only identities LINKED to the customer.
const listAuthIdentities = jest.fn(
  async (filter: { app_metadata?: { customer_id?: string } }) =>
    identities.filter(
      (i) => i.app_metadata.customer_id === filter.app_metadata?.customer_id,
    ),
);

const mkReq = (body: Record<string, unknown>) =>
  ({
    body,
    scope: {
      resolve: (key: string) => {
        if (key === 'configModule')
          return { projectConfig: { http: { jwtSecret: SECRET } } };
        if (key === Modules.CUSTOMER) return { listCustomers };
        if (key === Modules.AUTH) return { listAuthIdentities };
        if (key === PACKS_MODULE) return { isPhoneVerified };
        throw new Error(`unit scope: unexpected resolve('${key}')`);
      },
    },
  }) as never;

const mkRes = () => ({ json: jest.fn() });

/** Assert-and-return the rejection: a bare `rejects.toThrow` also passes when
 *  POST throws for an unrelated reason, and a resolved call must fail loudly
 *  rather than skip the assertions that follow. */
const rejection = async (promise: Promise<void>): Promise<MedusaError> => {
  try {
    await promise;
  } catch (e) {
    return e as MedusaError;
  }
  throw new Error('expected POST to reject, but it resolved');
};

// Both flags are process-wide. Capturing/restoring matters in BOTH directions
// here: a value leaking in from another spec file would make the flag-off cases
// pass for the wrong reason, and one leaking out would silently arm or disarm
// whatever runs next.
const ORIGINAL_ENV = {
  PHONE_VERIFICATION_REQUIRED: process.env.PHONE_VERIFICATION_REQUIRED,
  PHONE_GATE_REQUIRED: process.env.PHONE_GATE_REQUIRED,
};

beforeEach(() => {
  jest.clearAllMocks();
  customers = [{ id: 'cus_1', email: EMAIL }];
  phoneVerified = true;
  identities = [
    {
      app_metadata: { customer_id: 'cus_1' },
      provider_identities: [{ provider: 'emailpass', entity_id: EMAIL }],
    },
  ];
  delete process.env.PHONE_GATE_REQUIRED;
  process.env.PHONE_VERIFICATION_REQUIRED = 'true';
});

afterEach(() => {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('POST /store/phone-verification/password-reset — phone gate on', () => {
  it('exchanges a proof for a reset token', async () => {
    const res = mkRes();
    await POST(mkReq({ token: resetProof() }), res as never);

    expect(mintCount()).toBe(1);
    expect(res.json).toHaveBeenCalledWith({
      token: 'reset_token_stub',
      maskedEmail: expect.stringMatching(/^.\*+@test\.dev$/),
    });
  });

  // 2026-09-30: an email signup attempted on a Google account's address leaves
  // an emailpass identity with that email that is linked to NO customer. Keyed
  // on the email, the workflow found it and handed out a reset for a login
  // that signs into nothing.
  it('gives a Google account with an UNLINKED emailpass identity the Google answer, and mints nothing', async () => {
    identities = [
      {
        app_metadata: {},
        provider_identities: [{ provider: 'emailpass', entity_id: EMAIL }],
      },
      {
        app_metadata: { customer_id: 'cus_1' },
        provider_identities: [{ provider: 'google', entity_id: 'g-123' }],
      },
    ];
    const err = await rejection(
      POST(mkReq({ token: resetProof() }), mkRes() as never),
    );

    expect(err.type).toBe(MedusaError.Types.NOT_ALLOWED);
    expect(err.message).toBe('This account signs in with Google.');
    expect(mintCount()).toBe(0);
  });

  // A number that never passed an OTP on this account (written while the
  // flag was off, say) says nothing about who holds the account.
  it('refuses an account whose phone was never verified, and mints nothing', async () => {
    phoneVerified = false;
    const err = await rejection(
      POST(mkReq({ token: resetProof() }), mkRes() as never),
    );

    expect(err.type).toBe(MedusaError.Types.NOT_ALLOWED);
    expect(err.message).toBe(
      'This phone number is not verified on its account. Reset by email instead.',
    );
    expect(isPhoneVerified).toHaveBeenCalledWith('cus_1');
    expect(mintCount()).toBe(0);
    // Refused before the login lookup, so the answer says nothing about how
    // the account signs in.
    expect(listAuthIdentities.mock.calls.length).toBe(0);
  });

  // Every account in this file sits in a verification-exempt group (see the
  // jest.mock at the top). That exemption waives the money/goods gate only; it
  // does not make an unproven number a way into the account.
  it('ignores a verification-exempt group: an unverified partner is refused too', async () => {
    phoneVerified = false;
    const err = await rejection(
      POST(mkReq({ token: resetProof() }), mkRes() as never),
    );

    expect(err.type).toBe(MedusaError.Types.NOT_ALLOWED);
    expect(mintCount()).toBe(0);
  });
});

describe('POST /store/phone-verification/password-reset — phone gate off', () => {
  // The anti-regression pair for the case above. Delete the flag check and both
  // of these go green on a minted token, which IS the takeover chain: with
  // PHONE_VERIFICATION_REQUIRED off, blockUnverifiedPhoneWrite no-ops, so a
  // stolen session writes any number to /store/customers/me, OTPs it, and
  // exchanges it here for a real emailpass reset token.
  it.each([
    ['unset', undefined],
    ['explicitly false', 'false'],
    // Not 'true', so it is read as false — the same silent misread
    // resolvePhoneGateState warns about.
    ['a truthy-looking typo', 'True'],
  ])('refuses when the flag is %s, and mints nothing', async (_case, value) => {
    if (value === undefined) delete process.env.PHONE_VERIFICATION_REQUIRED;
    else process.env.PHONE_VERIFICATION_REQUIRED = value;

    const err = await rejection(
      POST(mkReq({ token: resetProof() }), mkRes() as never),
    );

    expect(err.type).toBe(MedusaError.Types.NOT_ALLOWED);
    expect(err.message).toBe('Phone recovery is unavailable. Reset by email instead.');
    expect(mintCount()).toBe(0);
    // Nor was the account even looked up — nothing about who owns this number
    // is disclosed, and no query is spent.
    expect(listCustomers.mock.calls.length).toBe(0);
  });

  // THE case that pins the parser choice. isPhoneGateRequired only FALLS BACK
  // to PHONE_VERIFICATION_REQUIRED when it is unset, so this combination makes
  // the two disagree: phone WRITES are ungated (the phone proves nothing) while
  // the money gate is on. Swap the route to isPhoneGateRequired and this one
  // goes red.
  it('refuses even when PHONE_GATE_REQUIRED is on', async () => {
    process.env.PHONE_VERIFICATION_REQUIRED = 'false';
    process.env.PHONE_GATE_REQUIRED = 'true';

    const err = await rejection(
      POST(mkReq({ token: resetProof() }), mkRes() as never),
    );

    expect(err.type).toBe(MedusaError.Types.NOT_ALLOWED);
    expect(mintCount()).toBe(0);
  });

  // Ordering: the gate sits AFTER the proof check, so a caller holding no valid
  // proof gets the pre-existing INVALID_DATA and learns nothing about the flag.
  // Move the gate to the top of the handler and this goes red.
  it('still answers an invalid proof with the proof error, not the flag one', async () => {
    delete process.env.PHONE_VERIFICATION_REQUIRED;

    const err = await rejection(
      POST(
        // A phone-change proof is a well-formed token for the WRONG purpose.
        mkReq({ token: signPhoneProof(SECRET, PHONE, 'phone-change') }),
        mkRes() as never,
      ),
    );

    expect(err.type).toBe(MedusaError.Types.INVALID_DATA);
    expect(err.message).toBe('Phone verification required.');
  });
});

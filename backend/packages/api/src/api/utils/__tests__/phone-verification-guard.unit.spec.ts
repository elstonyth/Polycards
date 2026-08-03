import { requireSignupPhoneProof, blockUnverifiedPhoneWrite } from '../phone-verification-guard';
import { signPhoneProof } from '../../../utils/phone-verification';

const SECRET = 'test-secret';
const PHONE = '+60107667787';

// Build a minimal MedusaRequest stand-in: body, headers, and a scope whose
// configModule carries jwtSecret (copies the reset-token-guard/address-guard
// req-mock idiom used by the sibling guard specs in this directory).
const makeReq = (body: unknown, headers: Record<string, string> = {}) => ({
  body,
  headers,
  scope: {
    resolve: (key: string) =>
      key === 'configModule'
        ? { projectConfig: { http: { jwtSecret: SECRET } } }
        : undefined,
  },
}) as never;

describe('requireSignupPhoneProof', () => {
  // Capture whatever this key was before the suite (a stray-set env, e.g. a
  // gitignored local .env, must not leak a permanent delete into other spec
  // files sharing this jest worker process) and restore it once, at the end.
  const ORIGINAL_PHONE_VERIFICATION_REQUIRED =
    process.env.PHONE_VERIFICATION_REQUIRED;
  afterAll(() => {
    if (ORIGINAL_PHONE_VERIFICATION_REQUIRED === undefined) {
      delete process.env.PHONE_VERIFICATION_REQUIRED;
    } else {
      process.env.PHONE_VERIFICATION_REQUIRED = ORIGINAL_PHONE_VERIFICATION_REQUIRED;
    }
  });

  const run = (req: never) =>
    new Promise<unknown>((resolve) => requireSignupPhoneProof(req, {} as never, resolve));

  it('passes untouched when enforcement is off', async () => {
    delete process.env.PHONE_VERIFICATION_REQUIRED;
    expect(await run(makeReq({ phone: PHONE }))).toBeUndefined();
  });

  describe('enforcement on', () => {
    beforeEach(() => {
      process.env.PHONE_VERIFICATION_REQUIRED = 'true';
    });
    afterEach(() => {
      delete process.env.PHONE_VERIFICATION_REQUIRED;
    });

    it('passes a phoneless body (Google signup carries no phone)', async () => {
      expect(await run(makeReq({ email: 'a@b.c' }))).toBeUndefined();
    });
    it('passes a valid signup proof for the same phone', async () => {
      const token = signPhoneProof(SECRET, PHONE, 'signup');
      expect(
        await run(makeReq({ phone: PHONE }, { 'x-phone-verification': token })),
      ).toBeUndefined();
    });
    it('rejects a missing header', async () => {
      expect(await run(makeReq({ phone: PHONE }))).toBeInstanceOf(Error);
    });
    it('rejects a proof for a different phone', async () => {
      const token = signPhoneProof(SECRET, '+15550001111', 'signup');
      expect(
        await run(makeReq({ phone: PHONE }, { 'x-phone-verification': token })),
      ).toBeInstanceOf(Error);
    });
    it('rejects a wrong-purpose proof', async () => {
      const token = signPhoneProof(SECRET, PHONE, 'phone-change');
      expect(
        await run(makeReq({ phone: PHONE }, { 'x-phone-verification': token })),
      ).toBeInstanceOf(Error);
    });
  });
});

describe('blockUnverifiedPhoneWrite', () => {
  // Same capture/restore as requireSignupPhoneProof above — see its comment.
  const ORIGINAL_PHONE_VERIFICATION_REQUIRED =
    process.env.PHONE_VERIFICATION_REQUIRED;
  afterAll(() => {
    if (ORIGINAL_PHONE_VERIFICATION_REQUIRED === undefined) {
      delete process.env.PHONE_VERIFICATION_REQUIRED;
    } else {
      process.env.PHONE_VERIFICATION_REQUIRED = ORIGINAL_PHONE_VERIFICATION_REQUIRED;
    }
  });

  const run = (req: never) =>
    new Promise<unknown>((resolve) => blockUnverifiedPhoneWrite(req, {} as never, resolve));

  it('passes when enforcement is off', async () => {
    delete process.env.PHONE_VERIFICATION_REQUIRED;
    expect(await run(makeReq({ phone: PHONE }))).toBeUndefined();
  });
  describe('enforcement on', () => {
    beforeEach(() => {
      process.env.PHONE_VERIFICATION_REQUIRED = 'true';
    });
    afterEach(() => {
      delete process.env.PHONE_VERIFICATION_REQUIRED;
    });

    it('rejects a string phone', async () => {
      expect(await run(makeReq({ phone: PHONE }))).toBeInstanceOf(Error);
    });
    it('allows clearing (null) and phoneless updates', async () => {
      expect(await run(makeReq({ phone: null }))).toBeUndefined();
      expect(await run(makeReq({ first_name: 'A' }))).toBeUndefined();
    });
  });
});

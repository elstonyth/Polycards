import {
  requireSignupPhoneProof,
  blockUnverifiedPhoneWrite,
  requirePhoneVerified,
} from '../phone-verification-guard';
import { Modules } from '@medusajs/framework/utils';
import { signPhoneProof } from '../../../utils/phone-verification';

const SECRET = 'test-secret';
const PHONE = '+60107667787';

// Build a minimal MedusaRequest stand-in: body, headers, and a scope whose
// configModule carries jwtSecret (copies the reset-token-guard/address-guard
// req-mock idiom used by the sibling guard specs in this directory).
// `claimants` seeds the customer module's listCustomers for the one-phone-one-
// account check (assertPhoneUnclaimed) — empty means the number is free.
const makeReq = (
  body: unknown,
  headers: Record<string, string> = {},
  claimants: { id: string }[] = [],
) =>
  ({
    body,
    headers,
    scope: {
      // Only the two keys the guards actually resolve. A catch-all would hand a
      // future guard a customer-module stub for whatever it asked for and pass
      // vacuously.
      resolve: (key: string) => {
        if (key === 'configModule')
          return { projectConfig: { http: { jwtSecret: SECRET } } };
        if (key === Modules.CUSTOMER)
          return { listCustomers: async () => claimants };
        return undefined;
      },
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
      process.env.PHONE_VERIFICATION_REQUIRED =
        ORIGINAL_PHONE_VERIFICATION_REQUIRED;
    }
  });

  // Stands in for the framework's wrapHandler (framework/dist/http/router.js
  // registers every defineMiddlewares entry through it): await the handler and
  // funnel a throw into the same `next(err)` channel, so a rejection and a
  // next(err) are indistinguishable here exactly as they are in the app.
  const run = (req: never) =>
    new Promise<unknown>((resolve) => {
      requireSignupPhoneProof(req, {} as never, resolve).catch(resolve);
    });

  it('passes untouched when enforcement is off', async () => {
    delete process.env.PHONE_VERIFICATION_REQUIRED;
    expect(await run(makeReq({ phone: PHONE }))).toBeUndefined();
  });

  // One phone = one account. Checked OUTSIDE the enforcement flag on purpose:
  // PHONE_VERIFICATION_REQUIRED is the rollback lever for OTP enforcement, and
  // pulling it must not silently reopen multi-accounting on one handset.
  it('rejects a phone another account already holds, flag off', async () => {
    delete process.env.PHONE_VERIFICATION_REQUIRED;
    const err = (await run(
      makeReq({ phone: PHONE }, {}, [{ id: 'cus_existing' }]),
    )) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/already in use/i);
  });

  it('rejects a duplicate phone even with a valid proof', async () => {
    process.env.PHONE_VERIFICATION_REQUIRED = 'true';
    const token = signPhoneProof(SECRET, PHONE, 'signup');
    const err = (await run(
      makeReq({ phone: PHONE }, { 'x-phone-verification': token }, [
        { id: 'cus_existing' },
      ]),
    )) as Error;
    // The MESSAGE, not merely "an Error": the proof check refuses too, so a
    // bare instanceof assertion would pass for the wrong refusal.
    expect(err.message).toMatch(/already in use/i);
    delete process.env.PHONE_VERIFICATION_REQUIRED;
  });

  // ORDERING, and the reason it is load-bearing: with the flag ARMED an
  // unproven caller must learn nothing about the number. Refusing the duplicate
  // first would make this route a "does this number have an account" oracle for
  // anyone holding one reusable register token — no OTP, unlimited probes.
  it('hides the duplicate behind the proof check when enforcement is on', async () => {
    process.env.PHONE_VERIFICATION_REQUIRED = 'true';
    const claimed = (await run(
      makeReq({ phone: PHONE }, {}, [{ id: 'cus_existing' }]),
    )) as Error;
    const free = (await run(makeReq({ phone: PHONE }))) as Error;
    // Same refusal either way — no signal to read.
    expect(claimed.message).toBe(free.message);
    expect(claimed.message).toMatch(/phone verification required/i);
    delete process.env.PHONE_VERIFICATION_REQUIRED;
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
      process.env.PHONE_VERIFICATION_REQUIRED =
        ORIGINAL_PHONE_VERIFICATION_REQUIRED;
    }
  });

  const run = (req: never) =>
    new Promise<unknown>((resolve) =>
      blockUnverifiedPhoneWrite(req, {} as never, resolve),
    );

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

describe('requirePhoneVerified', () => {
  // Same capture/restore as the two suites above — see their comment. Both keys
  // are captured: this gate reads its own switch first.
  const ORIGINAL_PHONE_VERIFICATION_REQUIRED =
    process.env.PHONE_VERIFICATION_REQUIRED;
  const ORIGINAL_PHONE_GATE_REQUIRED = process.env.PHONE_GATE_REQUIRED;
  afterAll(() => {
    if (ORIGINAL_PHONE_VERIFICATION_REQUIRED === undefined) {
      delete process.env.PHONE_VERIFICATION_REQUIRED;
    } else {
      process.env.PHONE_VERIFICATION_REQUIRED =
        ORIGINAL_PHONE_VERIFICATION_REQUIRED;
    }
    if (ORIGINAL_PHONE_GATE_REQUIRED === undefined) {
      delete process.env.PHONE_GATE_REQUIRED;
    } else {
      process.env.PHONE_GATE_REQUIRED = ORIGINAL_PHONE_GATE_REQUIRED;
    }
  });

  // actorId '' models a register-token bearer (see the guard); `verified`
  // throwing models a DB read failure, which must NOT become a free pass.
  const gateReq = (
    actorId: string | undefined,
    verified: boolean | (() => never),
  ) =>
    ({
      auth_context: actorId === undefined ? undefined : { actor_id: actorId },
      scope: {
        resolve: () => ({
          isPhoneVerified: async () =>
            typeof verified === 'function' ? verified() : verified,
        }),
      },
    }) as never;

  const run = (req: never) =>
    new Promise<unknown>((resolve) => {
      void requirePhoneVerified(req, {} as never, resolve);
    });

  it('passes untouched when enforcement is off, verified or not', async () => {
    delete process.env.PHONE_VERIFICATION_REQUIRED;
    expect(await run(gateReq('cus_1', false))).toBeUndefined();
  });

  // Both keys cleared before EVERY case, not just restored at the end: a
  // machine that already exports PHONE_GATE_REQUIRED would otherwise silently
  // decide these tests — 'false' makes every enforcement case pass vacuously,
  // 'true' breaks the enforcement-off case. Each test sets only what it needs.
  beforeEach(() => {
    delete process.env.PHONE_VERIFICATION_REQUIRED;
    delete process.env.PHONE_GATE_REQUIRED;
  });

  describe('enforcement on', () => {
    beforeEach(() => {
      process.env.PHONE_VERIFICATION_REQUIRED = 'true';
    });
    afterEach(() => {
      delete process.env.PHONE_VERIFICATION_REQUIRED;
    });

    it('passes a verified customer', async () => {
      expect(await run(gateReq('cus_1', true))).toBeUndefined();
    });
    it('refuses an unverified customer with actionable copy', async () => {
      const err = (await run(gateReq('cus_1', false))) as Error;
      expect(err).toBeInstanceOf(Error);
      // The storefront error tables key on this text (vault-errors.ts,
      // delivery-errors.ts) — a reword must break a test on both sides.
      expect(err.message).toMatch(/verify your phone/i);
    });
    it('refuses a register-token bearer (actor_id is empty until linked)', async () => {
      expect(await run(gateReq('', true))).toBeInstanceOf(Error);
      expect(await run(gateReq(undefined, true))).toBeInstanceOf(Error);
    });
    it('fails CLOSED when the state read throws', async () => {
      const boom = () => {
        throw new Error('db down');
      };
      expect(await run(gateReq('cus_1', boom))).toBeInstanceOf(Error);
    });

    // The point of the separate switch: kill the money gate WITHOUT reopening
    // the signup / phone-change gates, which stay on PHONE_VERIFICATION_REQUIRED.
    it('opens when PHONE_GATE_REQUIRED overrides to false', async () => {
      process.env.PHONE_GATE_REQUIRED = 'false';
      expect(await run(gateReq('cus_1', false))).toBeUndefined();
      delete process.env.PHONE_GATE_REQUIRED;
    });
  });

  it('closes on its OWN flag even with phone verification off', async () => {
    delete process.env.PHONE_VERIFICATION_REQUIRED;
    process.env.PHONE_GATE_REQUIRED = 'true';
    expect(await run(gateReq('cus_1', false))).toBeInstanceOf(Error);
    delete process.env.PHONE_GATE_REQUIRED;
  });
});

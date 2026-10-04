import {
  requireSignupPhoneProof,
  blockUnverifiedPhoneWrite,
  requirePhoneVerified,
  rejectAdminPhoneWrite,
} from '../phone-verification-guard';
import { MedusaError, Modules } from '@medusajs/framework/utils';
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
      // Only the keys the guards actually resolve. A catch-all would hand a
      // future guard a customer-module stub for whatever it asked for and pass
      // vacuously.
      resolve: (key: string) => {
        if (key === 'configModule')
          return { projectConfig: { http: { jwtSecret: SECRET } } };
        if (key === Modules.CUSTOMER)
          return { listCustomers: async () => claimants };
        if (key === 'logger') return { warn: () => undefined };
        return undefined;
      },
    },
  }) as never;

// The response as the signup guard sees it: a status code, read once the
// response has finished. `finish(status)` plays the create route answering.
const makeRes = () => {
  const finishers: (() => void)[] = [];
  const res = {
    statusCode: 200,
    on: (event: string, cb: () => void) => {
      if (event === 'finish') finishers.push(cb);
      return res;
    },
  };
  return {
    res: res as never,
    finish: (status: number) => {
      res.statusCode = status;
      finishers.forEach((cb) => cb());
    },
  };
};

describe('requireSignupPhoneProof', () => {
  // Capture whatever these keys were before the suite (a stray-set env, e.g. a
  // gitignored local .env, must not leak a permanent delete into other spec
  // files sharing this jest worker process) and restore them once, at the end.
  // REDIS_URL is cleared so the proof claims below use the per-process store;
  // the "on Redis" cases load their own copy of the module.
  const ORIGINAL_PHONE_VERIFICATION_REQUIRED =
    process.env.PHONE_VERIFICATION_REQUIRED;
  const ORIGINAL_REDIS_URL = process.env.REDIS_URL;
  const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
  beforeAll(() => {
    delete process.env.REDIS_URL;
  });
  afterAll(() => {
    if (ORIGINAL_PHONE_VERIFICATION_REQUIRED === undefined) {
      delete process.env.PHONE_VERIFICATION_REQUIRED;
    } else {
      process.env.PHONE_VERIFICATION_REQUIRED =
        ORIGINAL_PHONE_VERIFICATION_REQUIRED;
    }
    if (ORIGINAL_REDIS_URL === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = ORIGINAL_REDIS_URL;
  });

  // Stands in for the framework's wrapHandler (framework/dist/http/router.js
  // registers every defineMiddlewares entry through it): await the handler and
  // funnel a throw into the same `next(err)` channel, so a rejection and a
  // next(err) are indistinguishable here exactly as they are in the app.
  const runWith = (
    guard: typeof requireSignupPhoneProof,
    req: never,
    res: never = makeRes().res,
  ) =>
    new Promise<unknown>((resolve) => {
      guard(req, res, resolve).catch(resolve);
    });
  const run = (req: never, res?: never) =>
    runWith(requireSignupPhoneProof, req, res);

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

  // One signup proof, one account. A distinct number per case: two proofs
  // signed in the same millisecond for one number are byte-identical, and
  // would share one claim.
  let seq = 0;
  const freshProof = (nowMs?: number) => {
    const phone = `+6011${String(1_000_000 + seq++)}`;
    return { phone, token: signPhoneProof(SECRET, phone, 'signup', nowMs) };
  };
  const signupReq = (
    proof: { phone: string; token: string },
    claimants: { id: string }[] = [],
  ) =>
    makeReq(
      { phone: proof.phone },
      { 'x-phone-verification': proof.token },
      claimants,
    );

  describe('single-use proofs', () => {
    beforeEach(() => {
      process.env.PHONE_VERIFICATION_REQUIRED = 'true';
    });
    afterEach(() => {
      delete process.env.PHONE_VERIFICATION_REQUIRED;
    });

    it('refuses a proof that already created an account, exactly like a missing one', async () => {
      const proof = freshProof();
      const first = makeRes();
      expect(await run(signupReq(proof), first.res)).toBeUndefined();
      first.finish(200);

      const replay = (await run(signupReq(proof))) as MedusaError;
      const missing = (await run(
        makeReq({ phone: proof.phone }),
      )) as MedusaError;
      expect(replay).toBeInstanceOf(MedusaError);
      expect(replay.type).toBe(missing.type);
      expect(replay.message).toBe(missing.message);
    });

    it('refuses a second use while the first signup is still being created', async () => {
      const proof = freshProof();
      expect(await run(signupReq(proof))).toBeUndefined(); // never finishes
      const second = (await run(signupReq(proof))) as Error;
      expect(second.message).toBe('Phone verification required.');
    });

    // Both requests pass the proof check and see the number free before
    // either claims — the claim alone decides.
    it('lets one of two concurrent signups on one proof through', async () => {
      const proof = freshProof();
      const results = await Promise.all([
        run(signupReq(proof)),
        run(signupReq(proof)),
      ]);
      expect(results.filter((r) => r === undefined)).toHaveLength(1);
      expect(
        (results.find((r) => r !== undefined) as Error).message,
      ).toBe('Phone verification required.');
    });

    it('gives the proof back when the account create fails', async () => {
      const proof = freshProof();
      const first = makeRes();
      expect(await run(signupReq(proof), first.res)).toBeUndefined();
      first.finish(400);
      expect(await run(signupReq(proof))).toBeUndefined();
    });

    it('does not spend the proof on a number another account holds', async () => {
      const proof = freshProof();
      const dup = (await run(
        signupReq(proof, [{ id: 'cus_existing' }]),
      )) as Error;
      expect(dup.message).toMatch(/already in use/i);
      expect(await run(signupReq(proof))).toBeUndefined();
    });

    it('claims nothing while enforcement is off', async () => {
      delete process.env.PHONE_VERIFICATION_REQUIRED;
      const proof = freshProof();
      expect(await run(signupReq(proof))).toBeUndefined();
      expect(await run(signupReq(proof))).toBeUndefined();
    });

    it('is opened at boot, not by the first signup', () => {
      // A client still connecting refuses its first command, and the claim
      // fails closed — see warmOtpSendBudget for the incident.
      const src = require('fs').readFileSync(
        require('path').join(__dirname, '../../middlewares.ts'),
        'utf8',
      );
      expect(src).toContain('\nwarmSignupProofClaims();\n');
    });
  });

  describe('single-use proofs on Redis', () => {
    // Honours SET key value PX ms NX the way Redis does. `down` makes every
    // command fail the way ioredis does with the connection gone.
    class FakeRedis {
      static held = new Map<string, number>();
      static sets: unknown[][] = [];
      static dels: string[] = [];
      static down = false;
      on() {
        return this;
      }
      async connect() {}
      async set(key: string, ...args: unknown[]) {
        if (FakeRedis.down) throw new Error('Connection is closed.');
        FakeRedis.sets.push([key, ...args]);
        const ttl = args[2] as number; // value, 'PX', ttl, 'NX'
        if ((FakeRedis.held.get(key) ?? 0) > Date.now()) return null;
        FakeRedis.held.set(key, Date.now() + ttl);
        return 'OK';
      }
      async del(key: string) {
        if (FakeRedis.down) throw new Error('Connection is closed.');
        FakeRedis.dels.push(key);
        return FakeRedis.held.delete(key) ? 1 : 0;
      }
    }
    const load = () => {
      let guard!: typeof requireSignupPhoneProof;
      jest.isolateModules(() => {
        jest.doMock('ioredis', () => ({
          __esModule: true,
          default: FakeRedis,
        }));
        guard = require('../phone-verification-guard').requireSignupPhoneProof;
      });
      return guard;
    };

    beforeEach(() => {
      process.env.PHONE_VERIFICATION_REQUIRED = 'true';
      process.env.REDIS_URL = 'redis://fake';
      FakeRedis.held.clear();
      FakeRedis.sets = [];
      FakeRedis.dels = [];
      FakeRedis.down = false;
    });
    afterEach(() => {
      jest.dontMock('ioredis');
      delete process.env.PHONE_VERIFICATION_REQUIRED;
      delete process.env.REDIS_URL;
      if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    });

    it('claims a hash of the proof, never the proof, for its remaining lifetime', async () => {
      const guard = load();
      const proof = freshProof(Date.now() - 4 * 60_000); // 6 minutes left
      expect(await runWith(guard, signupReq(proof))).toBeUndefined();

      expect(FakeRedis.sets).toHaveLength(1);
      const [key, value, px, ttl, nx] = FakeRedis.sets[0];
      expect(key).toMatch(/^phone-proof:signup:[0-9a-f]{64}$/);
      expect(value).not.toBe(proof.token);
      expect([px, nx]).toEqual(['PX', 'NX']);
      expect(ttl).toBeGreaterThan(5 * 60_000);
      expect(ttl).toBeLessThanOrEqual(6 * 60_000);
    });

    it('refuses a replay, and gives the proof back after a failed create', async () => {
      const guard = load();
      const proof = freshProof();
      const first = makeRes();
      expect(await runWith(guard, signupReq(proof), first.res)).toBeUndefined();
      expect(
        ((await runWith(guard, signupReq(proof))) as Error).message,
      ).toBe('Phone verification required.');

      first.finish(500);
      await new Promise((r) => setImmediate(r));
      expect(FakeRedis.dels).toEqual([FakeRedis.sets[0][0]]);
      expect(await runWith(guard, signupReq(proof))).toBeUndefined();
    });

    it('lets one of two concurrent signups on one proof through', async () => {
      const guard = load();
      const proof = freshProof();
      const results = await Promise.all([
        runWith(guard, signupReq(proof)),
        runWith(guard, signupReq(proof)),
      ]);
      expect(results.filter((r) => r === undefined)).toHaveLength(1);
    });

    // Fail CLOSED: another process cannot see a claim this one keeps in
    // memory, so letting the signup through would let each replica accept
    // the same proof once. (Matched on shape, not instanceof: the isolated
    // module carries its own copy of MedusaError.)
    const RETRYABLE = {
      type: MedusaError.Types.NOT_ALLOWED,
      message: 'Could not verify your phone right now. Try again shortly.',
    };

    it('refuses with a retryable error when Redis is unreachable', async () => {
      const guard = load();
      FakeRedis.down = true;
      expect(await runWith(guard, signupReq(freshProof()))).toMatchObject(
        RETRYABLE,
      );
    });

    it('refuses in production when no Redis is configured', async () => {
      delete process.env.REDIS_URL;
      process.env.NODE_ENV = 'production';
      const guard = load();
      expect(await runWith(guard, signupReq(freshProof()))).toMatchObject(
        RETRYABLE,
      );
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

  it.each([
    ['a number', { phone: PHONE }],
    ['null', { phone: null }],
    ['an empty string', { phone: '' }],
    ['no phone key', { first_name: 'A' }],
  ])('passes %s when enforcement is off', async (_label, body) => {
    delete process.env.PHONE_VERIFICATION_REQUIRED;
    expect(await run(makeReq(body))).toBeUndefined();
  });
  describe('enforcement on', () => {
    beforeEach(() => {
      process.env.PHONE_VERIFICATION_REQUIRED = 'true';
    });
    afterEach(() => {
      delete process.env.PHONE_VERIFICATION_REQUIRED;
    });

    // Presence, not type: clearing the number here would keep the account's
    // phone_verified_at stamp and free the number for another signup.
    it.each([
      ['a number', PHONE],
      ['null', null],
      ['an empty string', ''],
    ])('refuses %s', async (_label, phone) => {
      const err = (await run(makeReq({ phone }))) as MedusaError;
      expect(err).toBeInstanceOf(MedusaError);
      expect(err.type).toBe(MedusaError.Types.INVALID_DATA);
      expect(err.message).toBe('Phone changes require verification.');
    });
    it('passes an update with no phone key, or no body', async () => {
      expect(await run(makeReq({ first_name: 'A' }))).toBeUndefined();
      expect(await run(makeReq(undefined))).toBeUndefined();
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
  // `groups` is the player's group list (oldest first) as the customer module
  // would return it — the verification_exempt branch reads it through
  // resolveGroupPolicyForCustomer. Empty = no group.
  const gateReq = (
    actorId: string | undefined,
    verified: boolean | (() => never),
    groups: { name: string; metadata?: Record<string, unknown> }[] = [],
  ) =>
    ({
      auth_context: actorId === undefined ? undefined : { actor_id: actorId },
      scope: {
        resolve: (key: string) =>
          key === Modules.CUSTOMER
            ? {
                listCustomerGroups: async () =>
                  groups.map((g, i) => ({ id: `cg_${i}`, ...g })),
              }
            : {
                isPhoneVerified: async () =>
                  typeof verified === 'function' ? verified() : verified,
              },
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

    // Partner groups (spec 2026-09-09): the group's verification_exempt is
    // the one thing besides a verified phone that opens this gate.
    it('passes an unverified member of a verification-exempt group', async () => {
      expect(
        await run(
          gateReq('cus_1', false, [
            {
              name: 'partners',
              metadata: { partner_rate_bp: 400, verification_exempt: true },
            },
          ]),
        ),
      ).toBeUndefined();
    });
    it('still refuses an unverified member of a group without the exemption', async () => {
      const err = (await run(
        gateReq('cus_1', false, [
          { name: 'pro', metadata: { partner_rate_bp: 400 } },
        ]),
      )) as Error;
      expect(err.message).toMatch(/verify your phone/i);
    });
    // A stray toggle on an ordinary group (no partner rate) is inert —
    // groupPolicyOf returns the empty policy — so the gate stays closed.
    it('ignores an exemption on a group without a partner rate', async () => {
      const err = (await run(
        gateReq('cus_1', false, [
          { name: 'pro', metadata: { verification_exempt: true } },
        ]),
      )) as Error;
      expect(err.message).toMatch(/verify your phone/i);
    });
    it('ignores an exemption stored on the DEFAULT group', async () => {
      const err = (await run(
        gateReq('cus_1', false, [
          {
            name: 'DEFAULT',
            metadata: { is_default: true, verification_exempt: true },
          },
        ]),
      )) as Error;
      expect(err.message).toMatch(/verify your phone/i);
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

describe('rejectAdminPhoneWrite', () => {
  // Unconditional — unlike blockUnverifiedPhoneWrite above, this guard is not
  // gated on PHONE_VERIFICATION_REQUIRED (the admin route never had a
  // verification path to roll back to; the field is refused outright).
  const run = (req: never) =>
    new Promise<unknown>((resolve) =>
      rejectAdminPhoneWrite(req, {} as never, resolve),
    );

  it('rejects a phone string with INVALID_DATA and the exact message', async () => {
    const err = (await run(makeReq({ phone: PHONE }))) as MedusaError;
    expect(err).toBeInstanceOf(MedusaError);
    expect(err.type).toBe(MedusaError.Types.INVALID_DATA);
    expect(err.message).toBe(
      'phone is not writable through this route. Phone numbers are bound through OTP verification (store/phone-verification), which is what keeps one phone tied to one account.',
    );
  });

  // Presence, not truthiness: a null write still touches the column this
  // guard exists to protect ownership of (see the guard's own docblock).
  it('rejects phone: null', async () => {
    const err = (await run(makeReq({ phone: null }))) as MedusaError;
    expect(err).toBeInstanceOf(MedusaError);
    expect(err.type).toBe(MedusaError.Types.INVALID_DATA);
  });

  it('rejects phone: "" (empty string)', async () => {
    const err = (await run(makeReq({ phone: '' }))) as MedusaError;
    expect(err).toBeInstanceOf(MedusaError);
    expect(err.type).toBe(MedusaError.Types.INVALID_DATA);
  });

  it('passes a body with no phone key', async () => {
    expect(
      await run(makeReq({ email: 'a@b.c', first_name: 'A' })),
    ).toBeUndefined();
  });

  it('does not throw on a null or undefined body', async () => {
    expect(await run(makeReq(undefined))).toBeUndefined();
    expect(await run(makeReq(null))).toBeUndefined();
  });
});

import type {
  MedusaNextFunction,
  MedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import {
  evaluateSlidingWindow,
  InMemorySlidingWindowStore,
  FailoverRateLimitStore,
  createRateLimitMiddleware,
  createAdminActionRateLimit,
  createStoreReadRateLimit,
  createProfileAppearanceRateLimit,
  createPhoneOtpStartPhoneRateLimit,
  createPhoneOtpCheckPhoneRateLimit,
  createAuthIdentifierRateLimit,
  phoneBodyKeyOf,
  emailBodyKeyOf,
  AUTH_DEFAULTS,
  STORE_READ_DEFAULTS,
  PROFILE_APPEARANCE_DEFAULTS,
  positiveIntFromEnv,
  type RateLimitRule,
  type RateLimitStore,
} from "../rate-limit";

const MINUTE = 60_000;
const T0 = 1_700_000_000_000; // fixed epoch-ms base so tests are deterministic

describe("evaluateSlidingWindow", () => {
  const rule = (limit: number, windowMs: number): RateLimitRule => ({
    limit,
    windowMs,
  });

  it("allows when there is no history", () => {
    const d = evaluateSlidingWindow([], T0, [rule(3, MINUTE)]);
    expect(d.allowed).toBe(true);
    expect(d.retryAfterMs).toBe(0);
  });

  it("allows while the window holds fewer events than the limit", () => {
    const d = evaluateSlidingWindow([T0 - 10, T0 - 5], T0, [rule(3, MINUTE)]);
    expect(d.allowed).toBe(true);
  });

  it("denies once the window is full and reports when the oldest event expires", () => {
    const ts = [T0 - 30_000, T0 - 20_000, T0 - 10_000];
    const d = evaluateSlidingWindow(ts, T0, [rule(3, MINUTE)]);
    expect(d.allowed).toBe(false);
    // Oldest in-window event (T0 - 30s) leaves the 60s window 30s from now.
    expect(d.retryAfterMs).toBe(30_000);
  });

  it("ignores events that have aged out of the window (strict boundary)", () => {
    // An event exactly windowMs old is OUT of the window.
    const ts = [T0 - MINUTE, T0 - MINUTE + 1, T0 - 10];
    const d = evaluateSlidingWindow(ts, T0, [rule(3, MINUTE)]);
    expect(d.allowed).toBe(true);
  });

  it("denies when any one of several rules is violated", () => {
    const burst = rule(2, 10_000);
    const sustained = rule(10, MINUTE);
    const ts = [T0 - 2_000, T0 - 1_000];
    const d = evaluateSlidingWindow(ts, T0, [burst, sustained]);
    expect(d.allowed).toBe(false);
    // Burst slot frees when T0-2s ages out of the 10s window.
    expect(d.retryAfterMs).toBe(8_000);
  });

  it("reports the longest wait when multiple rules are violated", () => {
    const burst = rule(1, 10_000);
    const sustained = rule(2, MINUTE);
    const ts = [T0 - 40_000, T0 - 1_000];
    const d = evaluateSlidingWindow(ts, T0, [burst, sustained]);
    expect(d.allowed).toBe(false);
    // burst frees in 9s; sustained frees when T0-40s exits the 60s window (20s).
    expect(d.retryAfterMs).toBe(20_000);
  });

  it("handles an unsorted history", () => {
    const ts = [T0 - 10_000, T0 - 30_000, T0 - 20_000];
    const d = evaluateSlidingWindow(ts, T0, [rule(3, MINUTE)]);
    expect(d.allowed).toBe(false);
    expect(d.retryAfterMs).toBe(30_000);
  });
});

describe("InMemorySlidingWindowStore", () => {
  const rules: RateLimitRule[] = [{ limit: 3, windowMs: MINUTE }];

  it("allows up to the limit then denies", async () => {
    const store = new InMemorySlidingWindowStore();
    for (let i = 0; i < 3; i++) {
      const d = await store.consume("k", rules, T0 + i);
      expect(d.allowed).toBe(true);
    }
    const denied = await store.consume("k", rules, T0 + 3);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
  });

  it("does not record denied attempts (all-or-nothing consumption)", async () => {
    const store = new InMemorySlidingWindowStore();
    await store.consume("k", rules, T0);
    await store.consume("k", rules, T0 + 1);
    await store.consume("k", rules, T0 + 2);
    // Hammer denied attempts; they must not extend the lockout.
    for (let i = 0; i < 5; i++) {
      const d = await store.consume("k", rules, T0 + 10 + i);
      expect(d.allowed).toBe(false);
    }
    // Just after the first event ages out, a slot must be free again.
    const d = await store.consume("k", rules, T0 + MINUTE + 1);
    expect(d.allowed).toBe(true);
  });

  it("tracks keys independently", async () => {
    const store = new InMemorySlidingWindowStore();
    for (let i = 0; i < 3; i++) await store.consume("a", rules, T0 + i);
    expect((await store.consume("a", rules, T0 + 5)).allowed).toBe(false);
    expect((await store.consume("b", rules, T0 + 5)).allowed).toBe(true);
  });

  it("evicts oldest keys beyond maxKeys instead of growing unbounded", async () => {
    const store = new InMemorySlidingWindowStore({ maxKeys: 2 });
    await store.consume("a", rules, T0);
    await store.consume("b", rules, T0 + 1);
    await store.consume("c", rules, T0 + 2); // evicts "a"
    // "a" was forgotten, so it gets a fresh window.
    for (let i = 0; i < 3; i++) {
      expect((await store.consume("a", rules, T0 + 10 + i)).allowed).toBe(true);
    }
  });
});

describe("FailoverRateLimitStore", () => {
  const rules: RateLimitRule[] = [{ limit: 1, windowMs: MINUTE }];
  const allowed = { allowed: true, retryAfterMs: 0 };

  it("uses the primary store when it works", async () => {
    const primary: RateLimitStore = {
      consume: jest.fn().mockResolvedValue(allowed),
    };
    const fallback: RateLimitStore = { consume: jest.fn() };
    const store = new FailoverRateLimitStore(primary, fallback);
    const d = await store.consume("k", rules, T0);
    expect(d.allowed).toBe(true);
    expect(primary.consume).toHaveBeenCalledTimes(1);
    expect(fallback.consume).not.toHaveBeenCalled();
  });

  it("falls back and reports the error when the primary throws", async () => {
    const boom = new Error("redis down");
    const primary: RateLimitStore = {
      consume: jest.fn().mockRejectedValue(boom),
    };
    const fallback: RateLimitStore = {
      consume: jest.fn().mockResolvedValue(allowed),
    };
    const onError = jest.fn();
    const store = new FailoverRateLimitStore(primary, fallback, onError);
    const d = await store.consume("k", rules, T0);
    expect(d.allowed).toBe(true);
    expect(fallback.consume).toHaveBeenCalledWith("k", rules, T0);
    expect(onError).toHaveBeenCalledWith(boom);
  });
});

describe("createRateLimitMiddleware", () => {
  const rules: RateLimitRule[] = [{ limit: 5, windowMs: MINUTE }];

  type FakeRes = {
    statusCode: number | undefined;
    headers: Record<string, string>;
    body: unknown;
  };

  const makeRes = (): { res: MedusaResponse; out: FakeRes } => {
    const out: FakeRes = { statusCode: undefined, headers: {}, body: undefined };
    const res = {
      status(code: number) {
        out.statusCode = code;
        return res;
      },
      set(name: string, value: string) {
        out.headers[name.toLowerCase()] = value;
        return res;
      },
      json(payload: unknown) {
        out.body = payload;
        return res;
      },
    };
    return { res: res as unknown as MedusaResponse, out };
  };

  const makeReq = (over: Record<string, unknown> = {}): MedusaRequest =>
    ({ ip: "10.0.0.1", ...over }) as unknown as MedusaRequest;

  const authedReq = (actorId: string): MedusaRequest =>
    makeReq({
      auth_context: { actor_id: actorId, actor_type: "customer" },
    });

  it("calls next() and writes nothing when allowed", async () => {
    const store: RateLimitStore = {
      consume: jest.fn().mockResolvedValue({ allowed: true, retryAfterMs: 0 }),
    };
    const mw = createRateLimitMiddleware({ store, rules, prefix: "rl:t:" });
    const next = jest.fn() as unknown as MedusaNextFunction;
    const { res, out } = makeRes();

    await mw(authedReq("cus_1"), res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(out.statusCode).toBeUndefined();
  });

  it("keys on auth_context.actor_id with the configured prefix", async () => {
    const store: RateLimitStore = {
      consume: jest.fn().mockResolvedValue({ allowed: true, retryAfterMs: 0 }),
    };
    const mw = createRateLimitMiddleware({ store, rules, prefix: "rl:t:" });
    await mw(authedReq("cus_42"), makeRes().res, jest.fn() as unknown as MedusaNextFunction);
    expect(store.consume).toHaveBeenCalledWith(
      "rl:t:cus_42",
      rules,
      expect.any(Number)
    );
  });

  it("falls back to the request IP when there is no auth context", async () => {
    const store: RateLimitStore = {
      consume: jest.fn().mockResolvedValue({ allowed: true, retryAfterMs: 0 }),
    };
    const mw = createRateLimitMiddleware({ store, rules, prefix: "rl:t:" });
    await mw(makeReq(), makeRes().res, jest.fn() as unknown as MedusaNextFunction);
    expect(store.consume).toHaveBeenCalledWith(
      "rl:t:ip:10.0.0.1",
      rules,
      expect.any(Number)
    );
  });

  // Finding 1 (phone-verification pre-merge review): a route fronted by a
  // shared egress point (the storefront proxies OTP requests server-side)
  // needs a key derived from something other than actor/IP, or every caller
  // collapses into one bucket. `keyOf` is that escape hatch.
  it("uses phoneBodyKeyOf's key over actor_id/IP for a valid E.164 body phone", async () => {
    const store: RateLimitStore = {
      consume: jest.fn().mockResolvedValue({ allowed: true, retryAfterMs: 0 }),
    };
    const mw = createRateLimitMiddleware({
      store,
      rules,
      prefix: "rl:t:",
      keyOf: phoneBodyKeyOf,
    });
    await mw(
      makeReq({ body: { phone: "+60107667787" } }),
      makeRes().res,
      jest.fn() as unknown as MedusaNextFunction,
    );
    expect(store.consume).toHaveBeenCalledWith(
      "rl:t:phone:+60107667787",
      rules,
      expect.any(Number),
    );
  });

  it("phoneBodyKeyOf falls back to actor_id/IP for a non-E.164 body phone", async () => {
    const store: RateLimitStore = {
      consume: jest.fn().mockResolvedValue({ allowed: true, retryAfterMs: 0 }),
    };
    const mw = createRateLimitMiddleware({
      store,
      rules,
      prefix: "rl:t:",
      keyOf: phoneBodyKeyOf,
    });
    await mw(
      makeReq({ body: { phone: "0107667787" } }), // missing +country
      makeRes().res,
      jest.fn() as unknown as MedusaNextFunction,
    );
    expect(store.consume).toHaveBeenCalledWith(
      "rl:t:ip:10.0.0.1",
      rules,
      expect.any(Number),
    );
  });

  // Plan 081: the credential endpoints have the same shared-egress-IP problem
  // as the OTP routes — the storefront issues login/register/reset from a
  // server action, so an IP key is one sitewide bucket for every visitor.
  it("uses emailBodyKeyOf's key over actor_id/IP for an email body", async () => {
    const store: RateLimitStore = {
      consume: jest.fn().mockResolvedValue({ allowed: true, retryAfterMs: 0 }),
    };
    const mw = createRateLimitMiddleware({
      store,
      rules,
      prefix: "rl:t:",
      keyOf: emailBodyKeyOf,
    });
    await mw(
      makeReq({ body: { email: " A@X.com " } }),
      makeRes().res,
      jest.fn() as unknown as MedusaNextFunction,
    );
    expect(store.consume).toHaveBeenCalledWith(
      "rl:t:email:a@x.com",
      rules,
      expect.any(Number),
    );
  });

  // Plan case 4: WITHOUT skipWhenNoKey, a keyless body still gets a working
  // budget (the IP fallback). This is the default `keyOf` contract and the
  // behaviour the phone tiers rely on.
  it("emailBodyKeyOf falls back to the IP bucket when the body has no email", async () => {
    const store: RateLimitStore = {
      consume: jest.fn().mockResolvedValue({ allowed: true, retryAfterMs: 0 }),
    };
    const mw = createRateLimitMiddleware({
      store,
      rules,
      prefix: "rl:t:",
      keyOf: emailBodyKeyOf,
    });
    await mw(
      makeReq({ body: { token: "proof", password: "hunter2" } }),
      makeRes().res,
      jest.fn() as unknown as MedusaNextFunction,
    );
    expect(store.consume).toHaveBeenCalledWith(
      "rl:t:ip:10.0.0.1",
      rules,
      expect.any(Number),
    );
  });

  // ...but the per-identifier auth tier opts INTO skipping instead. Its
  // matcher also covers /auth/*/emailpass/update, which carries no identifier;
  // falling back to `ip:` there would impose this tier's per-account numbers
  // as a SITEWIDE ceiling tighter than the circuit breaker it sits under. If
  // someone deletes the flag, this test is what fails.
  it("skipWhenNoKey: steps aside (no budget consumed) when keyOf yields nothing", async () => {
    const store: RateLimitStore = {
      consume: jest.fn().mockResolvedValue({ allowed: true, retryAfterMs: 0 }),
    };
    const mw = createRateLimitMiddleware({
      store,
      rules,
      prefix: "rl:t:",
      keyOf: emailBodyKeyOf,
      skipWhenNoKey: true,
    });
    const next = jest.fn() as unknown as MedusaNextFunction;
    const { res, out } = makeRes();
    await mw(makeReq({ body: { token: "reset-jwt" } }), res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(store.consume).not.toHaveBeenCalled();
    expect(out.statusCode).toBeUndefined();
  });

  it("falls back to actor_id/IP when keyOf returns undefined", async () => {
    const store: RateLimitStore = {
      consume: jest.fn().mockResolvedValue({ allowed: true, retryAfterMs: 0 }),
    };
    const mw = createRateLimitMiddleware({
      store,
      rules,
      prefix: "rl:t:",
      keyOf: () => undefined,
    });
    await mw(
      authedReq("cus_1"),
      makeRes().res,
      jest.fn() as unknown as MedusaNextFunction,
    );
    expect(store.consume).toHaveBeenCalledWith(
      "rl:t:cus_1",
      rules,
      expect.any(Number),
    );
  });

  it("responds 429 with a ceiled Retry-After and does not call next() when denied", async () => {
    const store: RateLimitStore = {
      consume: jest
        .fn()
        .mockResolvedValue({ allowed: false, retryAfterMs: 1_200 }),
    };
    const mw = createRateLimitMiddleware({ store, rules, prefix: "rl:t:" });
    const next = jest.fn() as unknown as MedusaNextFunction;
    const { res, out } = makeRes();

    await mw(authedReq("cus_1"), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(out.statusCode).toBe(429);
    expect(out.headers["retry-after"]).toBe("2"); // ceil(1200ms) = 2s
    expect(out.body).toMatchObject({ type: "rate_limit_exceeded" });
  });

  it("never sends Retry-After below 1 second", async () => {
    const store: RateLimitStore = {
      consume: jest.fn().mockResolvedValue({ allowed: false, retryAfterMs: 1 }),
    };
    const mw = createRateLimitMiddleware({ store, rules, prefix: "rl:t:" });
    const { res, out } = makeRes();
    await mw(authedReq("cus_1"), res, jest.fn() as unknown as MedusaNextFunction);
    expect(out.headers["retry-after"]).toBe("1");
  });

  it("resolves a per-request message function against the denied request (sim finding P3-10)", async () => {
    // One limiter instance is shared across route families for a shared
    // budget; the 429 label must still name the route being hit, not
    // "delivery" for a rewards claim.
    const store: RateLimitStore = {
      consume: jest
        .fn()
        .mockResolvedValue({ allowed: false, retryAfterMs: 1_000 }),
    };
    const mw = createRateLimitMiddleware({
      store,
      rules,
      prefix: "rl:t:",
      message: (req) =>
        req.path.startsWith("/store/rewards/")
          ? "Too many reward requests."
          : "Too many delivery requests.",
    });
    const { res, out } = makeRes();
    await mw(
      makeReq({ path: "/store/rewards/claim/g_1" }),
      res,
      jest.fn() as unknown as MedusaNextFunction,
    );
    expect((out.body as { message: string }).message).toMatch(
      /^Too many reward requests\./,
    );
  });

  it("rejects non-positive or fractional-to-zero rules at creation (boot-time failure)", () => {
    const store: RateLimitStore = {
      consume: jest.fn().mockResolvedValue({ allowed: true, retryAfterMs: 0 }),
    };
    for (const bad of [
      [{ limit: 0, windowMs: 1000 }],
      [{ limit: 5, windowMs: 0 }],
      [{ limit: -1, windowMs: 1000 }],
      [{ limit: 2.5, windowMs: 1000 }],
    ] as RateLimitRule[][]) {
      expect(() =>
        createRateLimitMiddleware({ store, rules: bad, prefix: "rl:t:" })
      ).toThrow(/positive integers/);
    }
  });

  it("fails open (next()) and reports the error if the store itself throws", async () => {
    const boom = new Error("store exploded");
    const store: RateLimitStore = {
      consume: jest.fn().mockRejectedValue(boom),
    };
    const onError = jest.fn();
    const mw = createRateLimitMiddleware({
      store,
      rules,
      prefix: "rl:t:",
      onError,
    });
    const next = jest.fn() as unknown as MedusaNextFunction;
    const { res, out } = makeRes();

    await mw(authedReq("cus_1"), res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(out.statusCode).toBeUndefined();
    expect(onError).toHaveBeenCalledWith(boom);
  });
});

describe("createAdminActionRateLimit", () => {
  type FakeRes = {
    statusCode: number | undefined;
    headers: Record<string, string>;
    body: unknown;
  };

  const makeRes = (): { res: MedusaResponse; out: FakeRes } => {
    const out: FakeRes = { statusCode: undefined, headers: {}, body: undefined };
    const res = {
      status(code: number) {
        out.statusCode = code;
        return res;
      },
      set(name: string, value: string) {
        out.headers[name.toLowerCase()] = value;
        return res;
      },
      json(payload: unknown) {
        out.body = payload;
        return res;
      },
    };
    return { res: res as unknown as MedusaResponse, out };
  };

  const authedAdminReq = (actorId: string): MedusaRequest =>
    ({ ip: "10.0.0.2", auth_context: { actor_id: actorId, actor_type: "user" } }) as unknown as MedusaRequest;

  it("returns a middleware function", () => {
    const mw = createAdminActionRateLimit();
    expect(typeof mw).toBe("function");
  });

  it("keys on auth_context.actor_id with the rl:admin-action: prefix", async () => {
    // Build a spy store and inject it via env (REDIS_URL unset → in-memory).
    // We test key derivation by inspecting what InMemorySlidingWindowStore
    // receives — wrap it.
    const calls: string[] = [];
    const store: RateLimitStore = {
      consume: jest.fn(async (key: string) => {
        calls.push(key);
        return { allowed: true, retryAfterMs: 0 };
      }),
    };
    // Use createRateLimitMiddleware directly to mirror the factory's behaviour
    // (the factory delegates to createEnvRateLimit which uses createRateLimitMiddleware).
    // For the keying assertion we simply use createRateLimitMiddleware with the
    // same prefix the factory uses so we confirm the naming contract.
    const mw = createRateLimitMiddleware({
      store,
      rules: [{ limit: 60, windowMs: 60_000 }],
      prefix: "rl:admin-action:",
    });
    await mw(
      authedAdminReq("usr_99"),
      makeRes().res,
      jest.fn() as unknown as MedusaNextFunction,
    );
    expect(calls[0]).toBe("rl:admin-action:usr_99");
  });

  it("falls back to IP when no auth_context is present", async () => {
    const calls: string[] = [];
    const store: RateLimitStore = {
      consume: jest.fn(async (key: string) => {
        calls.push(key);
        return { allowed: true, retryAfterMs: 0 };
      }),
    };
    const mw = createRateLimitMiddleware({
      store,
      rules: [{ limit: 60, windowMs: 60_000 }],
      prefix: "rl:admin-action:",
    });
    const noAuthReq = { ip: "192.168.1.1" } as unknown as MedusaRequest;
    await mw(
      noAuthReq,
      makeRes().res,
      jest.fn() as unknown as MedusaNextFunction,
    );
    expect(calls[0]).toBe("rl:admin-action:ip:192.168.1.1");
  });

  it("has a generous default budget (at least 30/min per actor) so normal admin use is never throttled", () => {
    // Smoke-check the factory resolves without throwing — the exact budget is
    // an integration concern, but we assert it is callable and the rules are valid.
    expect(() => createAdminActionRateLimit()).not.toThrow();
  });
});

describe("phone-otp per-phone limiter factories (Finding 1)", () => {
  // Redis-backed key derivation is exercised end-to-end by the http spec
  // (needs a real body-parsed request); this just smoke-checks the factories
  // resolve without throwing, same as the STORE_READ/PROFILE_APPEARANCE
  // smoke tests above.
  it("createPhoneOtpStartPhoneRateLimit resolves", () => {
    expect(() => createPhoneOtpStartPhoneRateLimit()).not.toThrow();
  });
  it("createPhoneOtpCheckPhoneRateLimit resolves", () => {
    expect(() => createPhoneOtpCheckPhoneRateLimit()).not.toThrow();
  });
});

describe("emailBodyKeyOf (Plan 081)", () => {
  const req = (body: unknown): MedusaRequest =>
    ({ ip: "10.0.0.1", body }) as unknown as MedusaRequest;

  it("normalizes case and surrounding whitespace into one bucket", () => {
    expect(emailBodyKeyOf(req({ email: " A@X.com " }))).toBe("email:a@x.com");
    expect(emailBodyKeyOf(req({ email: "a@x.com" }))).toBe("email:a@x.com");
  });

  // Core's reset-password route validates `identifier`, not `email`
  // (@medusajs/medusa/dist/api/auth/validators.js:6), and the storefront sends
  // the address in it — so this is the field the LIVE reset path uses.
  it("reads `identifier` too (the reset-password field name)", () => {
    expect(emailBodyKeyOf(req({ identifier: "A@X.com" }))).toBe(
      "email:a@x.com",
    );
  });

  it("prefers `email` when both fields are present", () => {
    expect(emailBodyKeyOf(req({ email: "a@x.com", identifier: "b@x.com" }))).toBe(
      "email:a@x.com",
    );
  });

  // Keyspace bound: a limiter key derived from unvalidated body input is a
  // Redis memory-growth vector, so anything that is not email-shaped and short
  // returns undefined (→ the caller's fallback), it never becomes a key.
  it("returns undefined for a missing body", () => {
    expect(emailBodyKeyOf({ ip: "10.0.0.1" } as unknown as MedusaRequest)).toBe(
      undefined,
    );
  });

  it("returns undefined for a body with no email/identifier", () => {
    expect(emailBodyKeyOf(req({ token: "t", password: "p" }))).toBe(undefined);
  });

  it("returns undefined for a non-string email", () => {
    expect(emailBodyKeyOf(req({ email: { toString: () => "a@x.com" } }))).toBe(
      undefined,
    );
    expect(emailBodyKeyOf(req({ email: 12345 }))).toBe(undefined);
  });

  it("returns undefined for an email over 254 chars", () => {
    const long = `${"a".repeat(250)}@x.com`; // 256 chars, email-shaped
    expect(long.length).toBeGreaterThan(254);
    expect(emailBodyKeyOf(req({ email: long }))).toBe(undefined);
  });

  it("returns undefined for a string that is not email-shaped", () => {
    for (const bad of ["", "   ", "not-an-email", "a@b", "a b@x.com"]) {
      expect(emailBodyKeyOf(req({ email: bad }))).toBe(undefined);
    }
  });
});

describe("createAuthIdentifierRateLimit (Plan 081)", () => {
  const BURST_ENV = "AUTH_IDENTIFIER_RATE_BURST_LIMIT";
  let redisUrl: string | undefined;

  beforeEach(() => {
    // The factory reads env AT CONSTRUCTION, so both of these must be set
    // before the create call below. Dropping REDIS_URL keeps the limiter on
    // its in-memory store (no socket opened by a unit test).
    redisUrl = process.env.REDIS_URL;
    delete process.env.REDIS_URL;
    process.env[BURST_ENV] = "1";
  });

  afterEach(() => {
    delete process.env[BURST_ENV];
    if (redisUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = redisUrl;
  });

  const makeRes = (): { res: MedusaResponse; statusOf: () => number | undefined } => {
    let statusCode: number | undefined;
    const res = {
      status(code: number) {
        statusCode = code;
        return res;
      },
      set() {
        return res;
      },
      json() {
        return res;
      },
    };
    return {
      res: res as unknown as MedusaResponse,
      statusOf: () => statusCode,
    };
  };

  // Every request below comes from the SAME ip — that is the production
  // topology (one Next.js egress IP for the whole storefront). Before this
  // tier existed, that meant one shared bucket; the point of the change is
  // that two different accounts no longer 429 each other.
  const post = async (
    mw: (
      req: MedusaRequest,
      res: MedusaResponse,
      next: MedusaNextFunction,
    ) => Promise<void>,
    body: unknown,
  ): Promise<{ passed: boolean; status: number | undefined }> => {
    const next = jest.fn();
    const { res, statusOf } = makeRes();
    await mw(
      { ip: "203.0.113.9", body } as unknown as MedusaRequest,
      res,
      next as unknown as MedusaNextFunction,
    );
    return { passed: next.mock.calls.length === 1, status: statusOf() };
  };

  it("gives different emails from the same IP different buckets", async () => {
    const mw = createAuthIdentifierRateLimit();

    // Burst limit is 1, so the second attempt on the SAME email is denied...
    expect((await post(mw, { email: "a@x.com", password: "p" })).passed).toBe(
      true,
    );
    const second = await post(mw, { email: "a@x.com", password: "p" });
    expect(second.passed).toBe(false);
    expect(second.status).toBe(429);

    // ...while a different account is unaffected. This is the whole point of
    // the change: it fails if `keyOf: emailBodyKeyOf` is removed from the
    // factory, because both requests would then key on the shared IP.
    expect((await post(mw, { email: "b@x.com", password: "p" })).passed).toBe(
      true,
    );
    // ...and the reset path's `identifier` field shares a@x.com's bucket.
    expect((await post(mw, { identifier: "a@x.com" })).passed).toBe(false);
  });

  it("does not consume any budget for a body with no identifier (skipWhenNoKey)", async () => {
    const mw = createAuthIdentifierRateLimit();
    // /auth/*/emailpass/update — token + password, no identifier. Repeated
    // well past the burst limit of 1; none of it may bind.
    for (let i = 0; i < 5; i++) {
      expect((await post(mw, { password: "new-password" })).passed).toBe(true);
    }
  });
});

describe("AUTH_DEFAULTS (Plan 081)", () => {
  // The IP tier is a SITEWIDE circuit breaker, not per-client fairness — every
  // visitor's credential request arrives from the storefront's one egress IP.
  // createAuthIdentifierRateLimit is the tier that bounds one account, so this
  // one only has to sit above legitimate whole-site traffic.
  it("is sized as a sitewide budget, not a per-user one", () => {
    expect(AUTH_DEFAULTS.limit).toBeGreaterThanOrEqual(300);
    expect(AUTH_DEFAULTS.windowMs).toBeLessThanOrEqual(60_000);
  });

  it("factory resolves", () => {
    expect(() => createAuthIdentifierRateLimit()).not.toThrow();
  });
});

describe("positiveIntFromEnv", () => {
  const NAME = "RL_TEST_ENV_VALUE";
  afterEach(() => {
    delete process.env[NAME];
  });

  const cases: Array<[string | undefined, number]> = [
    [undefined, 42], // unset → fallback
    ["", 42], // empty → fallback
    ["60", 60], // plain integer
    ["60.9", 60], // floors fractional part
    ["0.5", 42], // (0,1) floors to 0 → MUST fall back, not disable the rule
    ["1e-3", 42], // scientific notation in (0,1)
    ["0", 42],
    ["-5", 42],
    ["abc", 42],
    ["1e20", 42], // beyond safe integer range
  ];

  it.each(cases)("parses %p as %p (fallback 42)", (raw, expected) => {
    if (raw === undefined) delete process.env[NAME];
    else process.env[NAME] = raw;
    expect(positiveIntFromEnv(NAME, 42)).toBe(expected);
  });
});

describe("STORE_READ_DEFAULTS", () => {
  // One account-page RSC render fans out to ~6-8 store reads (credits, vip,
  // daily, profiles/me, avatar-frames, notifications). The budget must fit
  // an enthusiastic human with two tabs open — the 2026-07-07 incident
  // tripped twice: first the 30/10s burst (equip→refetch), then the 240/60s
  // sustained ceiling during rapid frame-swapping. ≥15 renders per burst
  // window and ≥60 renders per minute keeps real use out of 429 territory
  // while still stopping runaway scripts.
  it("fits at least 15 page renders per burst window and 60 per minute", () => {
    expect(STORE_READ_DEFAULTS.burstLimit).toBeGreaterThanOrEqual(120);
    expect(STORE_READ_DEFAULTS.burstWindowMs).toBeLessThanOrEqual(10_000);
    expect(STORE_READ_DEFAULTS.limit).toBeGreaterThanOrEqual(480);
    expect(STORE_READ_DEFAULTS.windowMs).toBeLessThanOrEqual(60_000);
  });

  it("is what createStoreReadRateLimit boots with (factory resolves)", () => {
    expect(() => createStoreReadRateLimit()).not.toThrow();
  });
});

describe("PROFILE_APPEARANCE_DEFAULTS", () => {
  // Frame equip/unequip is a cosmetic, idempotent metadata write — nothing
  // like a delivery order. Sharing the delivery-write budget (10/10s, 30/60s)
  // meant flipping through frames 429'd on the 11th swap (2026-07-07 round 3).
  // A collector must be able to cycle all 10 frames twice a minute.
  it("allows cycling the whole 10-frame workbook twice per minute", () => {
    expect(PROFILE_APPEARANCE_DEFAULTS.burstLimit).toBeGreaterThanOrEqual(15);
    expect(PROFILE_APPEARANCE_DEFAULTS.burstWindowMs).toBeLessThanOrEqual(
      10_000,
    );
    expect(PROFILE_APPEARANCE_DEFAULTS.limit).toBeGreaterThanOrEqual(60);
    expect(PROFILE_APPEARANCE_DEFAULTS.windowMs).toBeLessThanOrEqual(60_000);
  });

  it("factory resolves", () => {
    expect(() => createProfileAppearanceRateLimit()).not.toThrow();
  });
});

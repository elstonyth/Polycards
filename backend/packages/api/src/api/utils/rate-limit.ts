import type {
  AuthenticatedMedusaRequest,
  MedusaNextFunction,
  MedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import Redis from 'ioredis';

// Sliding-window rate limiting for the pack-open endpoint (and reusable for
// any future endpoint — the factory at the bottom is the only pack-specific
// part). There is no rate-limit facility anywhere in the Medusa/Mercur
// dependency tree (verified 2026-06-10), so this is hand-rolled on the same
// ioredis the Medusa redis modules use.
//
// Design:
// - One ZSET of event timestamps per key; every rule (burst + sustained)
//   counts the same events over its own window, atomically in one Lua script.
// - All-or-nothing consumption: a denied request records nothing, so hammering
//   a 429 never extends the lockout.
// - If Redis is unreachable the limiter fails over to a per-process in-memory
//   window (weaker across multiple workers, but never silently unlimited) and
//   keeps retrying Redis via ioredis' auto-reconnect.

export interface RateLimitRule {
  limit: number;
  windowMs: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterMs: number;
}

export interface RateLimitStore {
  consume(
    key: string,
    rules: RateLimitRule[],
    nowMs: number,
  ): Promise<RateLimitDecision>;
}

/**
 * Pure sliding-window-log decision over a list of event timestamps.
 * An event is inside a rule's window iff `ts > nowMs - windowMs` (strict, so
 * an event exactly windowMs old no longer counts). When denied, retryAfterMs
 * is how long until enough events age out of every violated rule's window for
 * one new event to fit. Mirrors the Lua script below — keep them in sync.
 */
export function evaluateSlidingWindow(
  timestampsMs: readonly number[],
  nowMs: number,
  rules: readonly RateLimitRule[],
): RateLimitDecision {
  const sorted = [...timestampsMs].sort((a, b) => a - b);
  let retryAfterMs = 0;
  for (const { limit, windowMs } of rules) {
    const cutoff = nowMs - windowMs;
    let start = sorted.length;
    for (let i = 0; i < sorted.length; i++) {
      if (sorted[i] > cutoff) {
        start = i;
        break;
      }
    }
    const inWindow = sorted.length - start;
    if (inWindow >= limit) {
      // The (inWindow - limit + 1) oldest in-window events must expire before
      // a new one fits; the last of those sits at index start + inWindow - limit.
      const freesAt = sorted[start + inWindow - limit] + windowMs;
      retryAfterMs = Math.max(retryAfterMs, freesAt - nowMs);
    }
  }
  return { allowed: retryAfterMs === 0, retryAfterMs };
}

/**
 * Per-process fallback store. Bounded: per-key history is pruned to the
 * largest window on every touch, and the key count is capped (oldest-inserted
 * key evicted first — not LRU, but cheap and good enough for a fallback).
 */
export class InMemorySlidingWindowStore implements RateLimitStore {
  private readonly events = new Map<string, number[]>();
  private readonly maxKeys: number;

  constructor(opts: { maxKeys?: number } = {}) {
    this.maxKeys = opts.maxKeys ?? 10_000;
  }

  async consume(
    key: string,
    rules: RateLimitRule[],
    nowMs: number,
  ): Promise<RateLimitDecision> {
    const maxWindow = Math.max(...rules.map((r) => r.windowMs));
    const history = (this.events.get(key) ?? []).filter(
      (t) => t > nowMs - maxWindow,
    );
    const decision = evaluateSlidingWindow(history, nowMs, rules);
    if (decision.allowed) {
      history.push(nowMs);
    }
    if (!this.events.has(key) && this.events.size >= this.maxKeys) {
      const oldest = this.events.keys().next().value;
      if (oldest !== undefined) this.events.delete(oldest);
    }
    this.events.set(key, history);
    return decision;
  }
}

// Mirrors evaluateSlidingWindow over a Redis ZSET, atomically:
// prune to the largest window, check every rule, and only record the event
// when every rule allows it. Returns {1, 0} or {0, retry_after_ms}.
//
// KEYS[1] = zset key; ARGV = [ nowMs, memberSuffix, ruleCount,
//                              limit_1, windowMs_1, ..., limit_n, windowMs_n ]
const SLIDING_WINDOW_LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local n = tonumber(ARGV[3])

local maxWindow = 0
for i = 1, n do
  local win = tonumber(ARGV[3 + 2 * i])
  if win > maxWindow then maxWindow = win end
end

redis.call('ZREMRANGEBYSCORE', key, 0, now - maxWindow)

local retry = 0
for i = 1, n do
  local limit = tonumber(ARGV[2 + 2 * i])
  local win = tonumber(ARGV[3 + 2 * i])
  local lower = '(' .. (now - win)
  local count = redis.call('ZCOUNT', key, lower, '+inf')
  if count >= limit then
    local entry = redis.call('ZRANGEBYSCORE', key, lower, '+inf', 'WITHSCORES', 'LIMIT', count - limit, 1)
    local wait = win
    if entry[2] then wait = tonumber(entry[2]) + win - now end
    if wait > retry then retry = wait end
  end
end

if retry > 0 then
  return { 0, math.ceil(retry) }
end

redis.call('ZADD', key, now, now .. '-' .. ARGV[2])
redis.call('PEXPIRE', key, maxWindow)
return { 1, 0 }
`;

interface RedisWithConsume extends Redis {
  rlConsume(
    key: string,
    nowMs: number,
    memberSuffix: string,
    ruleCount: number,
    ...limitWindowPairs: number[]
  ): Promise<[number, number]>;
}

// ZSET members must be unique even for same-millisecond opens.
let memberSeq = 0;
const nextMemberSuffix = (): string =>
  `${process.pid.toString(36)}-${(memberSeq++).toString(36)}`;

export class RedisSlidingWindowStore implements RateLimitStore {
  private readonly client: RedisWithConsume;

  constructor(client: Redis) {
    client.defineCommand('rlConsume', {
      numberOfKeys: 1,
      lua: SLIDING_WINDOW_LUA,
    });
    this.client = client as RedisWithConsume;
  }

  async consume(
    key: string,
    rules: RateLimitRule[],
    nowMs: number,
  ): Promise<RateLimitDecision> {
    const pairs: number[] = [];
    for (const r of rules) pairs.push(r.limit, r.windowMs);
    const [allowed, retryAfterMs] = await this.client.rlConsume(
      key,
      nowMs,
      nextMemberSuffix(),
      rules.length,
      ...pairs,
    );
    return { allowed: allowed === 1, retryAfterMs };
  }
}

/** Tries the primary store; on error reports it and uses the fallback. */
export class FailoverRateLimitStore implements RateLimitStore {
  constructor(
    private readonly primary: RateLimitStore,
    private readonly fallback: RateLimitStore,
    private readonly onError?: (err: unknown) => void,
  ) {}

  async consume(
    key: string,
    rules: RateLimitRule[],
    nowMs: number,
  ): Promise<RateLimitDecision> {
    try {
      return await this.primary.consume(key, rules, nowMs);
    } catch (err) {
      this.onError?.(err);
      return this.fallback.consume(key, rules, nowMs);
    }
  }
}

export interface RateLimitMiddlewareOptions {
  store: RateLimitStore;
  rules: RateLimitRule[];
  /** Namespaces the store key, e.g. "rl:pack-open:". */
  prefix: string;
  /** First sentence of the 429 body; default "Too many pack opens.". */
  message?: string;
  onError?: (err: unknown) => void;
}

type MiddlewareHandler = (
  req: MedusaRequest,
  res: MedusaResponse,
  next: MedusaNextFunction,
) => Promise<void>;

/**
 * Express-style middleware. Keys on the authenticated actor id (this must run
 * AFTER authenticate(), which populates req.auth_context); if there is no
 * auth context — misordering, or reuse on a public route — it keys on the
 * request IP rather than silently skipping the limit.
 */
export function createRateLimitMiddleware(
  opts: RateLimitMiddlewareOptions,
): MiddlewareHandler {
  const { store, rules, prefix, onError } = opts;
  // Misconfigured rules must fail at boot, loudly — limit 0 would 429 every
  // request and windowMs 0 would never deny one (see evaluateSlidingWindow's
  // strict window bound). Env parsing guarantees this for the pack-open
  // limiter; this guards direct reuse of the factory.
  for (const r of rules) {
    if (
      !Number.isSafeInteger(r.limit) ||
      r.limit <= 0 ||
      !Number.isSafeInteger(r.windowMs) ||
      r.windowMs <= 0
    ) {
      throw new Error(
        `[rate-limit] invalid rule ${JSON.stringify(r)} for prefix "${prefix}" — limit and windowMs must be positive integers`,
      );
    }
  }
  return async (req, res, next) => {
    let decision: RateLimitDecision;
    try {
      const auth = (req as AuthenticatedMedusaRequest).auth_context as
        | AuthenticatedMedusaRequest['auth_context']
        | undefined;
      const key = auth?.actor_id || `ip:${req.ip ?? 'unknown'}`;
      decision = await store.consume(prefix + key, rules, Date.now());
    } catch (err) {
      // A limiter bug must not take the endpoint down. The Redis store
      // already fails over to in-memory, so reaching here is exceptional.
      onError?.(err);
      next();
      return;
    }
    if (decision.allowed) {
      next();
      return;
    }
    const retryAfterSec = Math.max(1, Math.ceil(decision.retryAfterMs / 1000));
    res
      .status(429)
      .set('Retry-After', String(retryAfterSec))
      .json({
        type: 'rate_limit_exceeded',
        message: `${opts.message ?? 'Too many pack opens.'} Try again in ${retryAfterSec}s.`,
      });
  };
}

const DEFAULTS = {
  burstLimit: 5,
  burstWindowMs: 10_000,
  limit: 20,
  windowMs: 60_000,
};

export function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  // Floor BEFORE validating: 0 < n < 1 (e.g. "0.5") must be rejected, not
  // silently floored to 0 — windowMs=0 would disable the rule entirely and
  // limit=0 would hard-block the endpoint.
  const floored = Math.floor(Number(raw));
  if (!Number.isSafeInteger(floored) || floored <= 0) {
    console.warn(
      `[rate-limit] ignoring invalid ${name}=${JSON.stringify(raw)}; using ${fallback}`,
    );
    return fallback;
  }
  return floored;
}

// Logs at most once per interval so a dead Redis doesn't flood the logs at
// request rate (ioredis also emits 'error' on every reconnect attempt).
function throttledWarn(
  intervalMs: number,
): (msg: string, err?: unknown) => void {
  let last = 0;
  return (msg, err) => {
    const now = Date.now();
    if (now - last < intervalMs) return;
    last = now;
    const detail = err instanceof Error ? err.message : err;
    console.warn(`[rate-limit] ${msg}`, detail ?? '');
  };
}

// Redis-backed store with in-memory failover — shared by every limiter so each
// endpoint gets its own connection name but identical fail-fast semantics.
function buildFailoverStore(
  connectionName: string,
  warn: ReturnType<typeof throttledWarn>,
): RateLimitStore {
  const memory = new InMemorySlidingWindowStore();

  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    console.warn(
      `[rate-limit] REDIS_URL not set — ${connectionName} limiter is per-process (in-memory) only`,
    );
    return memory;
  }

  const client = new Redis(redisUrl, {
    // Fail fast when Redis is down (failover handles it) instead of
    // queueing commands and hanging requests.
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    commandTimeout: 500,
    connectionName,
  });
  // Without an 'error' listener ioredis connection failures become uncaught
  // exceptions; reconnection is automatic, so just log (throttled).
  client.on('error', (err) => warn('redis connection error', err));
  client.connect().catch((err) => warn('initial redis connect failed', err));
  return new FailoverRateLimitStore(
    new RedisSlidingWindowStore(client),
    memory,
    (err) => warn('redis consume failed; using in-memory fallback', err),
  );
}

type EnvLimiterDefaults = typeof DEFAULTS;

/**
 * Builds a burst + sustained limiter for one endpoint family. Everything
 * derives from `name` (kebab-case, e.g. "pack-open") so the three identities
 * can never drift: env vars `<NAME>_RATE_{BURST_LIMIT,BURST_WINDOW_MS,LIMIT,
 * WINDOW_MS}`, Redis connection name `<name>-rate-limit`, and store keyspace
 * `rl:<name>:`.
 */
function createEnvRateLimit(opts: {
  name: string;
  message?: string;
  defaults: EnvLimiterDefaults;
}): MiddlewareHandler {
  const { name, defaults } = opts;
  const envPrefix = `${name.toUpperCase().replace(/-/g, '_')}_RATE`;
  const rules: RateLimitRule[] = [
    {
      limit: positiveIntFromEnv(
        `${envPrefix}_BURST_LIMIT`,
        defaults.burstLimit,
      ),
      windowMs: positiveIntFromEnv(
        `${envPrefix}_BURST_WINDOW_MS`,
        defaults.burstWindowMs,
      ),
    },
    {
      limit: positiveIntFromEnv(`${envPrefix}_LIMIT`, defaults.limit),
      windowMs: positiveIntFromEnv(`${envPrefix}_WINDOW_MS`, defaults.windowMs),
    },
  ];

  const warn = throttledWarn(60_000);
  return createRateLimitMiddleware({
    store: buildFailoverStore(`${name}-rate-limit`, warn),
    rules,
    prefix: `rl:${name}:`,
    message: opts.message,
    onError: (err) => warn('limiter error; request allowed through', err),
  });
}

/**
 * The pack-open limiter: burst + sustained sliding windows per customer,
 * Redis-backed (REDIS_URL) with in-memory failover. Limits are env-tunable:
 * PACK_OPEN_RATE_BURST_LIMIT / PACK_OPEN_RATE_BURST_WINDOW_MS (default 5/10s)
 * PACK_OPEN_RATE_LIMIT / PACK_OPEN_RATE_WINDOW_MS (default 20/60s)
 */
export function createPackOpenRateLimit(): MiddlewareHandler {
  return createEnvRateLimit({ name: 'pack-open', defaults: DEFAULTS });
}

/**
 * The pack-open-batch limiter: burst + sustained sliding windows per customer,
 * Redis-backed (REDIS_URL) with in-memory failover. One batch request = up to
 * MAX_COUNT opens, so it gets its own independent budget rather than consuming
 * from the single-open limiter. Env-tunable:
 * PACK_OPEN_BATCH_RATE_BURST_LIMIT / PACK_OPEN_BATCH_RATE_BURST_WINDOW_MS (default 5/10s)
 * PACK_OPEN_BATCH_RATE_LIMIT / PACK_OPEN_BATCH_RATE_WINDOW_MS (default 20/60s)
 */
export function createPackOpenBatchRateLimit(): MiddlewareHandler {
  return createEnvRateLimit({ name: 'pack-open-batch', defaults: DEFAULTS });
}

/**
 * The vault-buyback limiter — same construction as pack-open, scoped per
 * customer. A buyback can happen at most once per pull (DB-enforced), so this
 * only throttles hammering. Env-tunable:
 * VAULT_BUYBACK_RATE_BURST_LIMIT / VAULT_BUYBACK_RATE_BURST_WINDOW_MS (10/10s)
 * VAULT_BUYBACK_RATE_LIMIT / VAULT_BUYBACK_RATE_WINDOW_MS (30/60s)
 */
export function createVaultBuybackRateLimit(): MiddlewareHandler {
  return createEnvRateLimit({
    name: 'vault-buyback',
    message: 'Too many buyback requests.',
    defaults: {
      burstLimit: 10,
      burstWindowMs: 10_000,
      limit: 30,
      windowMs: 60_000,
    },
  });
}

/**
 * The pull-reveal limiter — scoped per customer. The reveal ping fires once per
 * pull and is DB-idempotent, so this only throttles hammering. Env-tunable:
 * PULL_REVEAL_RATE_BURST_LIMIT / PULL_REVEAL_RATE_BURST_WINDOW_MS (20/10s)
 * PULL_REVEAL_RATE_LIMIT / PULL_REVEAL_RATE_WINDOW_MS (60/60s)
 */
export function createPullRevealRateLimit(): MiddlewareHandler {
  return createEnvRateLimit({
    name: 'pull-reveal',
    message: 'Too many requests.',
    defaults: {
      burstLimit: 20,
      burstWindowMs: 10_000,
      limit: 60,
      windowMs: 60_000,
    },
  });
}

/**
 * The credit-topup limiter — same construction as vault-buyback, scoped per
 * customer. Top-ups are gateway-backed writes (mock today), so the budget is
 * tighter than the read limiter but roomy for honest retries. Env-tunable:
 * CREDIT_TOPUP_RATE_BURST_LIMIT / CREDIT_TOPUP_RATE_BURST_WINDOW_MS (5/10s)
 * CREDIT_TOPUP_RATE_LIMIT / CREDIT_TOPUP_RATE_WINDOW_MS (15/60s)
 */
export function createCreditTopupRateLimit(): MiddlewareHandler {
  return createEnvRateLimit({
    name: 'credit-topup',
    message: 'Too many top-up requests.',
    defaults: {
      burstLimit: 5,
      burstWindowMs: 10_000,
      limit: 15,
      windowMs: 60_000,
    },
  });
}

/**
 * The delivery-write limiter (POST /store/delivery-orders + POST
 * /store/delivery-orders/:id/address) — scoped per customer. These are
 * state-changing writes (audit 2026-06-23: previously governed by the generous
 * store-READ budget); give them a tighter write-tier budget consistent with
 * topup/buyback. Still authed + ownership-checked, so this is anti-hammering
 * hardening. Env-tunable:
 * DELIVERY_WRITE_RATE_BURST_LIMIT / DELIVERY_WRITE_RATE_BURST_WINDOW_MS (10/10s)
 * DELIVERY_WRITE_RATE_LIMIT / DELIVERY_WRITE_RATE_WINDOW_MS (30/60s)
 */
export function createDeliveryWriteRateLimit(): MiddlewareHandler {
  return createEnvRateLimit({
    name: 'delivery-write',
    message: 'Too many delivery requests.',
    defaults: {
      burstLimit: 10,
      burstWindowMs: 10_000,
      limit: 30,
      windowMs: 60_000,
    },
  });
}

/**
 * The referral-recruit limiter — caps how fast NEW recruits can be added,
 * keyed per authenticated customer (the recruit). A sponsor cannot drive the
 * recruit's key, but this throttles automated tree-stuffing from one account.
 * Env-tunable: REFERRAL_RECRUIT_RATE_BURST_LIMIT / _BURST_WINDOW_MS (3/60s),
 * REFERRAL_RECRUIT_RATE_LIMIT / _WINDOW_MS (20/24h).
 */
export function createReferralRecruitRateLimit(): MiddlewareHandler {
  return createEnvRateLimit({
    name: 'referral-recruit',
    message: 'Too many referral attempts. Try again later.',
    defaults: {
      burstLimit: 3,
      burstWindowMs: 60_000,
      limit: 20,
      windowMs: 86_400_000, // 24h
    },
  });
}

/**
 * The auth-endpoint limiter (login / register / password reset). These routes
 * are PUBLIC — there is no auth_context yet — so the middleware keys on the
 * request IP (its designed fallback): this is brute-force/credential-stuffing
 * protection, not per-account fairness. Defaults are deliberately roomier than
 * a single user needs but far below hammering rates. Env-tunable:
 * AUTH_RATE_BURST_LIMIT / AUTH_RATE_BURST_WINDOW_MS (default 5/10s)
 * AUTH_RATE_LIMIT / AUTH_RATE_WINDOW_MS (default 20/60s)
 */
export function createAuthRateLimit(): MiddlewareHandler {
  return createEnvRateLimit({
    name: 'auth',
    message: 'Too many sign-in attempts.',
    defaults: DEFAULTS,
  });
}

/**
 * The public-profile read limiter (GET /store/profiles/:handle). The route is
 * PUBLIC — no auth_context — so the middleware keys on the request IP (its
 * designed fallback). NOTE: the storefront fetches profiles SERVER-side, so
 * every visitor's page view arrives from the one Next.js origin IP — the
 * budget below is therefore a whole-storefront budget, not per-visitor, and
 * is sized well above any human browsing rate while still stopping scripted
 * hammering/enumeration. Env-tunable:
 * PROFILE_READ_RATE_BURST_LIMIT / PROFILE_READ_RATE_BURST_WINDOW_MS (60/10s)
 * PROFILE_READ_RATE_LIMIT / PROFILE_READ_RATE_WINDOW_MS (600/60s)
 */
export function createProfileReadRateLimit(): MiddlewareHandler {
  return createEnvRateLimit({
    name: 'profile-read',
    message: 'Too many requests.',
    defaults: {
      burstLimit: 60,
      burstWindowMs: 10_000,
      limit: 600,
      windowMs: 60_000,
    },
  });
}

/**
 * The store-read limiter for the customer's own vault/credits GETs — cheap
 * reads, so the budget is generous; it only stops a runaway client or script
 * from hammering. One instance is shared by both matchers (a combined budget —
 * the two reads always travel together in the UI). Env-tunable:
 * STORE_READ_RATE_BURST_LIMIT / STORE_READ_RATE_BURST_WINDOW_MS (default 30/10s)
 * STORE_READ_RATE_LIMIT / STORE_READ_RATE_WINDOW_MS (default 120/60s)
 */
export function createStoreReadRateLimit(): MiddlewareHandler {
  return createEnvRateLimit({
    name: 'store-read',
    message: 'Too many requests.',
    defaults: {
      burstLimit: 30,
      burstWindowMs: 10_000,
      limit: 120,
      windowMs: 60_000,
    },
  });
}

/**
 * Rate-limiter for admin money-mutation routes (freeze/unfreeze, commission
 * reverse/suspend/unsuspend, rewards-settings, credit-adjust). Admins are
 * trusted operators, so the budget is deliberately generous — this is
 * anti-token-drain hardening, not a tight per-action throttle. One instance
 * is shared by all matched matchers so they share one budget and one Redis
 * connection. Keys on auth_context.actor_id (populated by the framework admin
 * auth); falls back to the request IP if no actor is present. Env-tunable:
 * ADMIN_ACTION_RATE_BURST_LIMIT / ADMIN_ACTION_RATE_BURST_WINDOW_MS (default 30/10s)
 * ADMIN_ACTION_RATE_LIMIT / ADMIN_ACTION_RATE_WINDOW_MS (default 200/60s)
 */
export function createAdminActionRateLimit(): MiddlewareHandler {
  return createEnvRateLimit({
    name: 'admin-action',
    message: 'Too many admin requests. Try again shortly.',
    defaults: {
      burstLimit: 30,
      burstWindowMs: 10_000,
      limit: 200,
      windowMs: 60_000,
    },
  });
}

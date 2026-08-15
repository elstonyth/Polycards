import type {
  AuthenticatedMedusaRequest,
  MedusaNextFunction,
  MedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import Redis from 'ioredis';
import { E164_RE } from '../../utils/phone-verification';

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

/**
 * First sentence of the 429 body. A function resolves per denied request —
 * used when one limiter instance (one shared budget) fronts several route
 * families and the label must name the route actually hit (sim finding
 * P3-10: a rewards claim answered "Too many delivery requests.").
 */
export type RateLimitMessage = string | ((req: MedusaRequest) => string);

export interface RateLimitMiddlewareOptions {
  store: RateLimitStore;
  rules: RateLimitRule[];
  /** Namespaces the store key, e.g. "rl:pack-open:". */
  prefix: string;
  /** Default "Too many pack opens.". */
  message?: RateLimitMessage;
  /**
   * Overrides the key derivation below (e.g. keying on a request-body field
   * instead of the actor/IP) — used when a route is fronted by a shared
   * egress point (a server-side proxy) that makes IP/actor keying collapse
   * into one sitewide bucket. Returning undefined falls through to the
   * existing actor_id → IP logic, so a route with no meaningful alternate key
   * (e.g. a malformed body) still gets a working budget.
   *
   * May return SEVERAL keys, in which case every one of them is charged and
   * the first denial wins. That is for a body carrying more than one candidate
   * identifier: charging only the one the route is believed to read makes the
   * limiter's correctness depend on route-matching semantics, and a caller who
   * can steer that choice gets a fresh bucket per request (see
   * `emailBodyKeyOf`). Charging all of them cannot be steered.
   */
  keyOf?: (req: MedusaRequest) => string | string[] | undefined;
  /**
   * Opt-in: when `keyOf` yields no key, SKIP this limiter entirely instead of
   * falling back to actor_id/IP. Only for a narrow per-identifier tier that is
   * stacked in front of a sitewide IP tier on a matcher whose route set is not
   * uniform — e.g. the auth wildcard matcher also covers the emailpass
   * `update` route, which carries a token and a password but no identifier
   * (see middlewares.ts). Without this, that route would
   * silently inherit the narrow tier's per-identifier ceiling as a SITEWIDE IP
   * ceiling (one storefront egress IP), which is tighter than the sitewide
   * tier it is supposed to sit under — the exact single-bucket bug the
   * per-identifier tier exists to fix. Safe because the sitewide tier still
   * runs on the same matcher, so a keyless request is never unlimited.
   * Default OFF: the phone tiers deliberately want the IP fallback, so a
   * malformed body still costs budget.
   *
   * KNOWN BLAST RADIUS (accepted, 2026-08-07). Skipping is all-or-nothing per
   * matcher, so it also applies to a LOGIN whose body has no key. The emailpass
   * provider never validates format — it uses `email` verbatim as entity_id —
   * so an account whose entity_id is not email-shaped (e.g. `user@localhost`)
   * produces no key, this tier steps aside, and that ONE account is bounded
   * only by the sitewide tier. The population is near-empty (the storefront
   * validates the format at signup and Google OAuth supplies real addresses),
   * and the alternative — a second limiter instance with the flag off for the
   * exact login matcher — caps every non-email-shaped login attempt at the
   * narrow tier's per-ACCOUNT numbers applied SITEWIDE, which is the
   * single-bucket bug this plan exists to remove, and splits the in-memory
   * failover budget across two instances. Documented rather than fixed.
   */
  skipWhenNoKey?: boolean;
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
  const { store, rules, prefix, onError, keyOf, skipWhenNoKey } = opts;
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
      const own = keyOf?.(req);
      // Falsy entries dropped (not just undefined) so the skip and the
      // fallback agree on what "no key" means — an extractor returning ''
      // must not key on ''.
      const ownKeys = (Array.isArray(own) ? own : [own]).filter(
        (k): k is string => Boolean(k),
      );
      if (!ownKeys.length && skipWhenNoKey) {
        next();
        return;
      }
      const keys = ownKeys.length
        ? ownKeys
        : [auth?.actor_id || `ip:${req.ip ?? 'unknown'}`];
      // First denial wins. ponytail: the all-or-nothing guarantee holds per
      // key, not across keys — when one of several keys denies, the earlier
      // ones have already recorded their event. Bounded at one extra event on
      // one bucket, and only reachable for a body carrying two identifiers,
      // which no legitimate client sends. A cross-key atomic path would mean a
      // multi-key Lua script; add it only if multi-key ever becomes the norm.
      decision = { allowed: true, retryAfterMs: 0 };
      const now = Date.now();
      for (const k of keys) {
        const d = await store.consume(prefix + k, rules, now);
        if (!d.allowed) {
          decision = d;
          break;
        }
      }
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
    const label =
      (typeof opts.message === 'function' ? opts.message(req) : opts.message) ??
      'Too many pack opens.';
    res
      .status(429)
      .set('Retry-After', String(retryAfterSec))
      .json({
        type: 'rate_limit_exceeded',
        message: `${label} Try again in ${retryAfterSec}s.`,
      });
  };
}

const DEFAULTS = {
  burstLimit: 5,
  burstWindowMs: 10_000,
  limit: 20,
  windowMs: 60_000,
};

/**
 * Like positiveIntFromEnv, but 0 is a VALID value rather than a reason to fall
 * back.
 *
 * For a rate limiter, 0 is meaningless (windowMs=0 disables the rule, limit=0
 * hard-blocks the endpoint), which is why the sibling rejects it. For a money
 * CEILING it is the opposite: 0 is the most important value an operator can set,
 * because it is the stop lever during an incident. Routing it to the fallback
 * meant reaching for that lever silently produced the DEFAULT cap — wide open —
 * with only a log line saying the value was ignored.
 */
export function nonNegativeIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  // Digits only. Number(' ') === 0 and Number('0x0') === 0, so a whitespace or
  // alternate-notation value would otherwise read as a deliberate zero and
  // silently disarm the cap.
  if (!/^\d+$/.test(raw.trim())) {
    console.warn(
      `[rate-limit] ignoring invalid ${name}=${JSON.stringify(raw)}; using ${fallback}`,
    );
    return fallback;
  }
  const n = Number(raw.trim());
  if (!Number.isSafeInteger(n)) {
    console.warn(
      `[rate-limit] ignoring out-of-range ${name}=${JSON.stringify(raw)}; using ${fallback}`,
    );
    return fallback;
  }
  return n;
}

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

// Shared by the two per-phone OTP limiters (see the "Phone-OTP limiters"
// comment below). App middlewares (this file's consumers, wired in
// middlewares.ts) run AFTER Medusa's own body-parser middleware — confirmed
// against @medusajs/framework's router.js, which registers
// applyBodyParserMiddleware before any route/middleware from this app — so
// req.body is already populated here (the existing rejectCustomerMetadata
// guard relies on the same ordering). Falls back to undefined (→ IP) rather
// than throwing when the body has no string phone; the route handler 400s
// that shape independently.
export const phoneBodyKeyOf = (req: MedusaRequest): string | undefined => {
  const phone = (req.body as { phone?: unknown } | undefined)?.phone;
  // Bounded: only a shape that actually passes the route's own E.164 check
  // becomes a key — an arbitrary/oversized body string would otherwise key
  // (and grow) the limiter's keyspace directly off unvalidated input.
  return typeof phone === 'string' && E164_RE.test(phone)
    ? `phone:${phone}`
    : undefined;
};

// Same shape the storefront validates with before it ever calls the backend
// (src/lib/actions/auth.ts EMAIL_RE) — deliberately permissive, its job is to
// BOUND the limiter keyspace, not to validate an address (the route's own
// provider does that).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// RFC 5321 maximum forward-path length. A limiter key must never be able to
// grow with attacker-supplied input.
const MAX_EMAIL_LEN = 254;

/**
 * Per-identifier key for the credential endpoints — the email sibling of
 * `phoneBodyKeyOf`, for the same shared-egress-IP reason (see the "Phone-OTP
 * limiters" comment below; the storefront issues every login/register/reset
 * from a server action, so the backend sees one egress IP for every visitor).
 *
 * Field names verified against the installed packages, not assumed:
 * - `email`      — POST /auth/:actor/emailpass (login) and .../register:
 *                  @medusajs/auth-emailpass/dist/services/emailpass.js:51,100
 *                  (`const { email, password } = userData.body ?? {}`).
 * - `identifier` — POST /auth/:actor/:provider/reset-password:
 *                  @medusajs/medusa/dist/api/auth/validators.js:6 and that
 *                  route's route.js:8. The storefront sends the email in it
 *                  (src/lib/actions/auth.ts:377-378).
 * - .../update carries only a token + password (no identifier at all:
 *   @medusajs/medusa/dist/api/auth/[actor_type]/[auth_provider]/update/route.js:8-11),
 *   so this returns undefined there — see `skipWhenNoKey` above.
 *
 * Normalizes (trim + lowercase) so `A@x.com ` and `a@x.com` share one bucket,
 * and bounds the keyspace the same way `phoneBodyKeyOf` does: only an
 * email-shaped value of at most 254 chars becomes a key — an arbitrary or
 * oversized body string would otherwise key (and grow) a Redis-backed
 * limiter's keyspace directly off unvalidated input. The `email:` prefix keeps
 * it from ever colliding with a `phone:` or `ip:` key.
 *
 * Returns EVERY email-shaped candidate in the body, not just the one this
 * route is expected to read, and the middleware charges all of them. This
 * middleware runs BEFORE core's body validator (app wildcard matchers sort
 * ahead of core's param matchers), so req.body still carries whatever extra
 * keys the caller sent, and each route family reads only ONE of the two names.
 * Charging just the expected one made the control depend on route matching:
 * express 4 defaults here are `strict: false` / `caseSensitive: false`, so
 * `.../reset-password/` and `.../Reset-Password` route to the same handler,
 * and an exact path test misses them. A caller who can steer the choice sends
 * { email: '<fresh random>@x.com', identifier: 'victim@x.com' }, gets a brand
 * new bucket every request, and bombs the victim with reset mail unbounded.
 * The path is normalized below (both defects fixed), but charging every
 * candidate is what makes the guarantee independent of express's matching
 * semantics — one framework upgrade must not silently reopen this.
 * Legitimate clients send exactly one of the two fields, so this is one key
 * and one `consume` on every real request.
 */
export const emailBodyKeyOf = (req: MedusaRequest): string[] | undefined => {
  const body = req.body as
    | { email?: unknown; identifier?: unknown }
    | undefined;
  const toKey = (raw: unknown): string | undefined => {
    if (typeof raw !== 'string') return undefined;
    const normalized = raw.trim().toLowerCase();
    return normalized.length <= MAX_EMAIL_LEN && EMAIL_RE.test(normalized)
      ? `email:${normalized}`
      : undefined;
  };
  // Trailing slashes and casing are both insignificant to express's matcher,
  // so they must be insignificant here too. Ordering only decides which key is
  // charged FIRST (nicer 429 attribution); both are charged either way.
  const path = (req.path ?? '').toLowerCase().replace(/\/+$/, '');
  const fields = path.endsWith('/reset-password')
    ? [body?.identifier, body?.email]
    : [body?.email, body?.identifier];
  const keys = [...new Set(fields.map(toKey))].filter(
    (k): k is string => k !== undefined,
  );
  return keys.length ? keys : undefined;
};

/**
 * Builds a burst + sustained limiter for one endpoint family. Everything
 * derives from `name` (kebab-case, e.g. "pack-open") so the three identities
 * can never drift: env vars `<NAME>_RATE_{BURST_LIMIT,BURST_WINDOW_MS,LIMIT,
 * WINDOW_MS}`, Redis connection name `<name>-rate-limit`, and store keyspace
 * `rl:<name>:`.
 */
function createEnvRateLimit(opts: {
  name: string;
  message?: RateLimitMessage;
  defaults: EnvLimiterDefaults;
  keyOf?: (req: MedusaRequest) => string | string[] | undefined;
  skipWhenNoKey?: boolean;
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
    keyOf: opts.keyOf,
    skipWhenNoKey: opts.skipWhenNoKey,
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
export function createDeliveryWriteRateLimit(
  message: RateLimitMessage = 'Too many delivery requests.',
): MiddlewareHandler {
  return createEnvRateLimit({
    name: 'delivery-write',
    message,
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
 * The auth-endpoint limiter, SITEWIDE (login / register / password reset /
 * reset-completion). These routes are PUBLIC — there is no auth_context yet —
 * so the middleware keys on the request IP (its designed fallback), and the
 * storefront issues every credential request from a SERVER ACTION
 * (src/lib/actions/auth.ts is 'use server'; src/lib/medusa.ts forwards no
 * client headers), so in production that IP is the one Next.js egress IP for
 * every visitor. This tier is therefore a whole-site CIRCUIT BREAKER, not
 * per-client fairness — same stance as createProfileReadRateLimit and the
 * phone-OTP IP tiers. `createAuthIdentifierRateLimit` below is the tier that
 * bounds attempts against ONE account; it runs first (middlewares.ts).
 *
 * Its own defaults object, NOT the shared `DEFAULTS`: that one is also read by
 * createPackOpenRateLimit / createPackOpenBatchRateLimit, and widening it in
 * place would silently widen two unrelated gameplay limiters.
 *
 * The two rules are deliberately CONSISTENT (50 per 10s = 300 per minute).
 * Do not "tighten" the burst on its own: the burst is the binding rule, so a
 * low one silently overrides the sustained ceiling and re-creates the sitewide
 * bucket this tier was widened to remove — at 5/10s the real ceiling was
 * 30/min sitewide, a trivial DoS lever that 429'd honest sign-ins. Sized below
 * the repo's other by-topology-sitewide limiters (createProfileReadRateLimit
 * 60/10s + 600/60s, STORE_READ_DEFAULTS 120/10s + 480/60s) because auth volume
 * is far lower, and still orders of magnitude under a credential-stuffing run
 * — which createAuthIdentifierRateLimit bounds PER ACCOUNT anyway. That tier,
 * not this one, is what protects a single account.
 * Env-tunable:
 * AUTH_RATE_BURST_LIMIT / AUTH_RATE_BURST_WINDOW_MS (default 50/10s)
 * AUTH_RATE_LIMIT / AUTH_RATE_WINDOW_MS (default 300/60s)
 */
export const AUTH_DEFAULTS: EnvLimiterDefaults = {
  burstLimit: 50,
  burstWindowMs: 10_000,
  limit: 300,
  windowMs: 60_000,
};

export function createAuthRateLimit(): MiddlewareHandler {
  return createEnvRateLimit({
    name: 'auth',
    message: 'Too many sign-in attempts.',
    defaults: AUTH_DEFAULTS,
  });
}

/**
 * The auth-endpoint limiter, PER-IDENTIFIER (login / register / password
 * reset). Keys on the email in the request body (`emailBodyKeyOf`) so it
 * survives the single-egress-IP topology described above — the email sibling
 * of createPhoneOtpStartPhoneRateLimit, and the reason this plan exists: an
 * IP-only auth limiter is one sitewide bucket, so one user's retries can 429
 * every other user's sign-in, and anyone who knows that can hold the bucket
 * empty. Runs BEFORE the IP tier (middlewares.ts) so a hammered account 429s
 * before spending the sitewide budget.
 *
 * `skipWhenNoKey` because the '/auth/*' wildcard matcher also covers the
 * emailpass `update` route, which carries no identifier: without it that route
 * would fall back to `ip:` and inherit these per-account numbers as a SITEWIDE
 * ceiling far tighter than the circuit breaker above. It still consumes the
 * sitewide tier on the same matcher, so nothing is unlimited.
 *
 * Budget: a human who has forgotten their password tries a handful of times in
 * a minute and a couple of dozen in an hour; a credential-stuffing run against
 * one account does far more. Deliberately roomier than a legitimate user needs
 * and far below hammering rates. Note login and password-reset share this one
 * per-email budget, so ~5 login typos inside a minute also defer the immediate
 * "forgot password" click by up to that minute. Env-tunable:
 * AUTH_IDENTIFIER_RATE_BURST_LIMIT / _BURST_WINDOW_MS (default 5/60s)
 * AUTH_IDENTIFIER_RATE_LIMIT / _WINDOW_MS (default 20/1h)
 */
export function createAuthIdentifierRateLimit(): MiddlewareHandler {
  return createEnvRateLimit({
    name: 'auth-identifier',
    message: 'Too many sign-in attempts for this account.',
    keyOf: emailBodyKeyOf,
    skipWhenNoKey: true,
    defaults: {
      burstLimit: 5,
      burstWindowMs: 60_000,
      limit: 20,
      windowMs: 3_600_000,
    },
  });
}

/**
 * The account-delete limiter. The route takes a password, so an unthrottled
 * one is a password oracle — but the generic `createAuthRateLimit` is the
 * WRONG throttle for it: with no `keyOf` it keys on `auth_context.actor_id`
 * (already populated by authenticate()), giving a per-customer 50/10s + 300/60s
 * budget. That is looser than the write tier it would stack with, so stacking
 * adds nothing, and ~90× looser than the login path that guards the same
 * secret. These numbers mirror createAuthIdentifierRateLimit instead, because
 * that is the tier bounding password guesses per account. Env-tunable:
 * ACCOUNT_DELETE_RATE_BURST_LIMIT / _BURST_WINDOW_MS (default 3/60s)
 * ACCOUNT_DELETE_RATE_LIMIT / _WINDOW_MS (default 20/1h)
 */
export function createAccountDeleteRateLimit(): MiddlewareHandler {
  return createEnvRateLimit({
    name: 'account-delete',
    message: 'Too many delete attempts for this account.',
    defaults: {
      burstLimit: 3,
      burstWindowMs: 60_000,
      limit: 20,
      windowMs: 3_600_000,
    },
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
 * from hammering. One instance is shared by all read matchers (a combined
 * budget), and one account-page RSC render fans out to ~6-8 of these reads
 * at once. Sized for an enthusiastic human with two tabs open: the 2026-07-07
 * incident tripped twice — first the 30/10s burst (equip→refetch fan-out),
 * then a 240/60s sustained ceiling during rapid frame-swapping. ≥15 renders
 * per burst window, ≥60 renders/min; still stops runaway scripts by an order
 * of magnitude. Env-tunable:
 * STORE_READ_RATE_BURST_LIMIT / STORE_READ_RATE_BURST_WINDOW_MS (default 120/10s)
 * STORE_READ_RATE_LIMIT / STORE_READ_RATE_WINDOW_MS (default 480/60s)
 */
export const STORE_READ_DEFAULTS: EnvLimiterDefaults = {
  burstLimit: 120,
  burstWindowMs: 10_000,
  limit: 480,
  windowMs: 60_000,
};

export function createStoreReadRateLimit(): MiddlewareHandler {
  return createEnvRateLimit({
    name: 'store-read',
    message: 'Too many requests.',
    defaults: STORE_READ_DEFAULTS,
  });
}

/**
 * The profile-appearance limiter (POST /store/profile/frame). Frame equip/
 * unequip is a cosmetic, idempotent metadata write — a collector comparing
 * frames flips through them fast, so it must NOT share the tight delivery-
 * write budget (10/10s tripped on the 11th swap, 2026-07-07). Sized to cycle
 * the whole 10-frame workbook twice a minute with margin; still caps a
 * runaway script at ~1 write/s sustained. Env-tunable:
 * PROFILE_APPEARANCE_RATE_BURST_LIMIT / _BURST_WINDOW_MS (default 15/10s)
 * PROFILE_APPEARANCE_RATE_LIMIT / _WINDOW_MS (default 60/60s)
 */
export const PROFILE_APPEARANCE_DEFAULTS: EnvLimiterDefaults = {
  burstLimit: 15,
  burstWindowMs: 10_000,
  limit: 60,
  windowMs: 60_000,
};

export function createProfileAppearanceRateLimit(): MiddlewareHandler {
  return createEnvRateLimit({
    name: 'profile-appearance',
    message: 'Too many appearance changes.',
    defaults: PROFILE_APPEARANCE_DEFAULTS,
  });
}

/**
 * The notification-read limiter (POST /store/notifications/:id/read). This is
 * a lightweight idempotent write (upsert of a read-state row), so the budget
 * is more generous than credit mutations but tighter than the read limiter.
 * Env-tunable:
 * NOTIFICATION_READ_RATE_BURST_LIMIT / NOTIFICATION_READ_RATE_BURST_WINDOW_MS (default 20/10s)
 * NOTIFICATION_READ_RATE_LIMIT / NOTIFICATION_READ_RATE_WINDOW_MS (default 100/60s)
 */
export function createNotificationReadRateLimit(): MiddlewareHandler {
  return createEnvRateLimit({
    name: 'notification-read',
    message: 'Too many mark-read requests.',
    defaults: {
      burstLimit: 20,
      burstWindowMs: 10_000,
      limit: 100,
      windowMs: 60_000,
    },
  });
}

/**
 * The bulk mark-read limiter (POST /store/notifications/read-all). One call
 * clears the whole feed page, so a human needs this only a handful of times a
 * minute — far tighter than the per-id limiter it replaces for bulk work, and
 * deliberately its own tier so a runaway read-all loop cannot eat the per-id
 * budget a normal feed interaction depends on. Env-tunable:
 * NOTIFICATION_READ_ALL_RATE_BURST_LIMIT / _BURST_WINDOW_MS (default 5/10s)
 * NOTIFICATION_READ_ALL_RATE_LIMIT / _WINDOW_MS (default 30/60s)
 */
export function createNotificationReadAllRateLimit(): MiddlewareHandler {
  return createEnvRateLimit({
    name: 'notification-read-all',
    message: 'Too many mark-all-read requests.',
    defaults: {
      burstLimit: 5,
      burstWindowMs: 10_000,
      limit: 30,
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

/**
 * The gateway-hook limiter (POST /hooks/globepay/{deposit,withdrawal,
 * payout-verify}). Those routes are unauthenticated BY DESIGN — a webhook
 * carries no token and its authentication is the RSA signature — so before
 * this existed an anonymous caller had no budget at all on an endpoint that
 * does blocking cryptography: §1.16 forces `openCallback` to decrypt before it
 * can verify, so a forged body still cost a real AES decrypt (and, until plan
 * 089 memoized it, a 1000-round PBKDF2) on the single event loop.
 *
 * THIS IS AN ABUSE CEILING, NOT AUTHENTICATION and not fairness between
 * callers. The gateway is the only legitimate caller and should never come
 * near these numbers. The signature is, and stays, the real gate — see the
 * maintenance note in plan 089: "the hooks are rate-limited now" is never a
 * reason to relax signature verification.
 *
 * Keyed on IP (the middleware's default) — a webhook has no auth_context and
 * no useful body key: every field is inside the encrypted `Data` blob.
 * Medusa's express loader sets `trust proxy` 1 unconditionally (see
 * utils/payer-ip.ts), so `req.ip` comes from the proxy chain and a caller
 * cannot rotate its own key by spoofing X-Forwarded-For. If the deployed chain
 * is deeper than one hop the key collapses to one upstream address for all
 * callers — which does not weaken a ceiling on a surface that has exactly one
 * legitimate caller.
 *
 * Sized generously, because a 429 to a genuine callback costs something:
 * - deposit / withdrawal callbacks: recoverable. The gateway retries (per the
 *   integration guide, not observed here), and — independently of whether it
 *   does — the two reconcile jobs (src/jobs/globepay-*reconcile.ts, cron every
 *   10 min) requery the gateway for anything still pending, so the settlement
 *   lands late rather than never.
 * - payout-verify: fails CLOSED. Anything but a literal "success" makes the
 *   gateway refuse that payout, so a 429 blocks a legitimate withdrawal from
 *   paying out (no money moves wrongly, but a customer waits).
 * That asymmetry is why the ceiling sits orders of magnitude above real
 * callback volume: if one ever trips it, raise the env var, don't remove it.
 *
 * The two rules are deliberately CONSISTENT (100 per 10s = 600 per minute =
 * the sustained rule). The burst is always the binding rule, so a tighter one
 * silently overrides the sustained ceiling and makes the documented number a
 * lie — the scar recorded on AUTH_DEFAULTS above. Plan 089 suggested 60/10s;
 * that would have made the real ceiling 360/min, so the burst was raised to
 * match rather than shipping an inconsistent pair.
 * Env-tunable:
 * GATEWAY_HOOK_RATE_BURST_LIMIT / GATEWAY_HOOK_RATE_BURST_WINDOW_MS (100/10s)
 * GATEWAY_HOOK_RATE_LIMIT / GATEWAY_HOOK_RATE_WINDOW_MS (600/60s)
 */
export function createGatewayHookRateLimit(): MiddlewareHandler {
  return createEnvRateLimit({
    name: 'gateway-hook',
    message: 'Too many callback requests.',
    defaults: {
      burstLimit: 100,
      burstWindowMs: 10_000,
      limit: 600,
      windowMs: 60_000,
    },
  });
}

// Phone-OTP limiters are keyed in TWO independent dimensions, both applied
// (see middlewares.ts): a per-phone tier (below) and this IP tier. Why both —
// the storefront's phone-verification server actions proxy every OTP request
// through the Next.js server (src/lib/actions/phone-verification.ts), so in
// production the backend sees exactly ONE egress IP for every visitor. An
// IP-only limiter is therefore a SITEWIDE bucket, not per-client fairness:
// one user's retries can 429 every other user's signup/change/reset OTPs,
// and it's trivially DoS-able by anyone who knows that. The per-phone tier
// (createPhoneOtpStartPhoneRateLimit / createPhoneOtpCheckPhoneRateLimit)
// keys on the phone number in the request body instead, so it survives the
// shared-IP topology and is the real per-client / SMS-cost cap. This IP tier
// is kept as a second, deliberately generous circuit breaker against
// whole-site SMS-spend abuse — sized above legitimate sitewide traffic, with
// Twilio's own Fraud Guard + geo-lock as the upstream defense. Both factories
// below build their own env-driven limiter (own Redis connection) rather than
// sharing one instance — they are genuinely distinct budgets (per-phone vs.
// sitewide), so collapsing them into one shared limiter would silently merge
// the two buckets back into the single-bucket bug this split fixes.

/**
 * The phone-OTP send limiter, PER-PHONE (POST /store/phone-verification/start).
 * PUBLIC route — keys on the `phone` field in the request body (falls back to
 * IP if the body has no string phone; the route itself 400s that shape
 * anyway). This is the primary fairness/SMS-cost cap: each allowed request
 * can cost real money (one SMS), layered under Twilio Verify's own
 * per-number caps. Runs BEFORE the IP tier below (middlewares.ts) so a
 * hammered number 429s before spending the sitewide budget. Env-tunable:
 * PHONE_OTP_START_PHONE_RATE_BURST_LIMIT / _BURST_WINDOW_MS (default 3/10min)
 * PHONE_OTP_START_PHONE_RATE_LIMIT / _WINDOW_MS (default 6/24h)
 */
export function createPhoneOtpStartPhoneRateLimit(): MiddlewareHandler {
  return createEnvRateLimit({
    name: 'phone-otp-start-phone',
    message: 'Too many code requests for this number.',
    keyOf: phoneBodyKeyOf,
    defaults: {
      burstLimit: 3,
      burstWindowMs: 600_000,
      limit: 6,
      windowMs: 86_400_000,
    },
  });
}

/**
 * The phone-OTP send limiter, SITEWIDE (POST /store/phone-verification/start).
 * PUBLIC route — keys on the request IP (its designed fallback), which in
 * production is the storefront's one egress IP (see the module comment
 * above) — so this is a whole-storefront SMS-spend circuit breaker, NOT
 * per-client fairness (createPhoneOtpStartPhoneRateLimit is that tier).
 * Env-tunable:
 * PHONE_OTP_START_RATE_BURST_LIMIT / _BURST_WINDOW_MS (default 30/60s)
 * PHONE_OTP_START_RATE_LIMIT / _WINDOW_MS (default 300/1h)
 */
export function createPhoneOtpStartRateLimit(): MiddlewareHandler {
  return createEnvRateLimit({
    name: 'phone-otp-start',
    message: 'Too many code requests.',
    defaults: {
      burstLimit: 30,
      burstWindowMs: 60_000,
      limit: 300,
      windowMs: 3_600_000,
    },
  });
}

/**
 * The phone-OTP check limiter, PER-PHONE (POST /store/phone-verification/check).
 * PUBLIC — same keyOf as the start-phone limiter above. Bounds code guessing
 * against one specific number; Twilio additionally caps 5 checks per
 * verification. Runs BEFORE the IP tier below (middlewares.ts). Env-tunable:
 * PHONE_OTP_CHECK_PHONE_RATE_BURST_LIMIT / _BURST_WINDOW_MS (default 10/10min)
 * PHONE_OTP_CHECK_PHONE_RATE_LIMIT / _WINDOW_MS (default 30/24h)
 */
export function createPhoneOtpCheckPhoneRateLimit(): MiddlewareHandler {
  return createEnvRateLimit({
    name: 'phone-otp-check-phone',
    message: 'Too many verification attempts for this number.',
    keyOf: phoneBodyKeyOf,
    defaults: {
      burstLimit: 10,
      burstWindowMs: 600_000,
      limit: 30,
      windowMs: 86_400_000,
    },
  });
}

/**
 * The phone-OTP check limiter, SITEWIDE (POST /store/phone-verification/check).
 * PUBLIC — keys on IP, which in production is the storefront's one egress IP
 * (see the module comment above): a sitewide circuit breaker, not per-client
 * fairness (createPhoneOtpCheckPhoneRateLimit is that tier). Env-tunable:
 * PHONE_OTP_CHECK_RATE_BURST_LIMIT / _BURST_WINDOW_MS (default 60/60s)
 * PHONE_OTP_CHECK_RATE_LIMIT / _WINDOW_MS (default 600/1h)
 */
export function createPhoneOtpCheckRateLimit(): MiddlewareHandler {
  return createEnvRateLimit({
    name: 'phone-otp-check',
    message: 'Too many verification attempts.',
    defaults: {
      burstLimit: 60,
      burstWindowMs: 60_000,
      limit: 600,
      windowMs: 3_600_000,
    },
  });
}

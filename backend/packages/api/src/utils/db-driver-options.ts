/**
 * Production Postgres driver options.
 *
 * Lives in src/ (rather than inline in medusa-config.ts) for the same reason
 * assertMockTopupSafe and isResendConfigured do: medusa-config only builds this
 * object when NODE_ENV is production, so the values below are unreachable from
 * a test that imports the config. Here they're a plain function over `env`.
 */

/**
 * Per-process cap when DB_POOL_MAX is unset or unusable.
 *
 * Unset, knex fills `max: 10` PER PROCESS — and the pool is per-process, not
 * per-module (medusa-app-loader injects one shared PG_CONNECTION into all ~25
 * modules). Production runs three consumers against a 25-connection cluster
 * (~22 usable): the `backend` service, the `worker`, and the PRE_DEPLOY
 * `migrate` job, which runs while the old containers are still serving.
 * 3 x 10 = 30 > 25, so any traffic spike overlapping a deploy exhausts the
 * cluster and every acquire fails with KnexTimeoutError against a perfectly
 * healthy database. 3 x 5 = 15 leaves headroom for an operator psql.
 */
export const DEFAULT_DB_POOL_MAX = 5;

/** Kills a transaction abandoned mid-flight before it holds its connection —
 * and its locks — indefinitely. Safe at 30s because every
 * `@InjectTransactionManager` method in the packs service is DB-only; fetch and
 * axios live exclusively in non-transactional routes and jobs. */
const IDLE_IN_TRANSACTION_TIMEOUT_MS = 30_000;

export type ProductionDatabaseDriverOptions = {
  connection: { ssl: { rejectUnauthorized: boolean } };
  pool: { min: number; max: number };
  idle_in_transaction_session_timeout: number;
};

/**
 * Resolve the pool ceiling from the environment.
 *
 * Every rejected input below is a silent outage, not a style preference:
 *
 * - **Blank.** A DigitalOcean variable that is DECLARED BUT BLANK — the common
 *   case when adding a per-component variable — makes `Number('')` evaluate to
 *   0, and a `max` of 0 hangs every acquire for knex's full 60s
 *   acquireConnectionTimeout. A self-inflicted outage on the very deploy that
 *   adds the cap.
 * - **Negative.** Truthy, so `|| DEFAULT` alone would let it through to knex.
 * - **Partially numeric.** `Number.parseInt` stops at the first non-digit, so
 *   `'5.9'` silently becomes 5 and — the dangerous one — `'1e3'` written for
 *   1000 becomes **1**, serializing every query in the process behind a
 *   single connection.
 *
 * - **Absurdly large.** Enough digits still match `^\d+$` but overflow the safe
 *   integer range (or evaluate to Infinity), silently uncapping the very pool
 *   this exists to cap.
 *
 * Hence a strict digits-only match rather than a lenient parse: anything that
 * isn't unambiguously a positive safe integer falls back to the default, which
 * is always safe.
 */
export const resolveDbPoolMax = (env: NodeJS.ProcessEnv): number => {
  const raw = (env.DB_POOL_MAX ?? '').trim();
  const value = /^\d+$/.test(raw) ? Number(raw) : NaN;
  return Number.isSafeInteger(value) && value > 0
    ? value
    : DEFAULT_DB_POOL_MAX;
};

/**
 * The `databaseDriverOptions` block for production.
 *
 * Shape matters as much as the values — `pool` and
 * `idle_in_transaction_session_timeout` must be SIBLINGS of `connection`, not
 * nested inside it: pg-connection-loader reads `driverOptions.pool` at the top
 * level (and `delete`s it before forwarding the rest), while
 * create-pg-connection reads `idle_in_transaction_session_timeout` off
 * driverOptions directly. Nesting either one silently drops it.
 *
 * `min: 0` survives the loader intact (it uses `?? 2`, not `||`). It only trades
 * idle connections for a cold connect on the next request; the `max` cap is the
 * actual fix.
 *
 * statement_timeout and lock_timeout CANNOT be set here at all —
 * create-pg-connection builds the knex `connection` as an object literal with a
 * fixed key set, so both are silently discarded. They belong on the runtime
 * DATABASE_URL (`?options=-c%20statement_timeout%3D60000%20-c%20lock_timeout%3D5000`),
 * never as a role-level setting: that would also bind the migrate job, whose
 * non-CONCURRENT CREATE INDEX would then be killed mid-deploy.
 *
 * `ssl.rejectUnauthorized: false` is required because DO Managed Postgres
 * presents a self-signed CA that node-postgres otherwise rejects with
 * SELF_SIGNED_CERT_IN_CHAIN (still TLS-encrypted, just not cert-verified).
 * DATABASE_URL must NOT carry `?sslmode=require` — the framework only strips
 * `ssl_mode` (underscore), so the literal spelling survives, forces strict
 * verification, and overrides this option.
 */
export const productionDatabaseDriverOptions = (
  env: NodeJS.ProcessEnv,
): ProductionDatabaseDriverOptions => ({
  connection: { ssl: { rejectUnauthorized: false } },
  pool: { min: 0, max: resolveDbPoolMax(env) },
  idle_in_transaction_session_timeout: IDLE_IN_TRANSACTION_TIMEOUT_MS,
});

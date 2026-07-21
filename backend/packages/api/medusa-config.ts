import { loadEnv, defineConfig } from '@medusajs/framework/utils';
import { DashboardModuleOptions } from '@mercurjs/types';
import path from 'path';
import { assertMockTopupSafe } from './src/modules/packs/topup';
import { isResendConfigured } from './src/modules/resend/options';
import { productionDatabaseDriverOptions } from './src/utils/db-driver-options';
loadEnv(process.env.NODE_ENV || 'development', process.cwd());

// Boot-guard (security audit 2026-06-30, Batch A): refuse to start a production
// server that would mint free credit through the always-approving mock gateway
// (ALLOW_MOCK_TOPUP=true in prod). Runs at config load, the same fail-fast point
// as the JWT/COOKIE secret checks below.
assertMockTopupSafe(process.env);

// Secrets pass through UNDEFINED when unset so Medusa's own ConfigManager
// gate stays live: it already fail-fasts in production on a missing
// jwtSecret/cookieSecret and applies the "supersecret" dev default (with a
// warning) otherwise — a local `|| "supersecret"` fallback here would feed it
// a "found" value and mute that gate. The one case the framework can't catch
// is a secret EXPLICITLY set to the known dev literal; reject that ourselves,
// using the framework's own definition of production ("production" or
// "prod"). Generation one-liner lives in .env.template's PROD CHECKLIST.
const isProduction = ['production', 'prod'].includes(
  process.env.NODE_ENV || '',
);

// Integration tests (TEST_TYPE set) force Medusa's in-memory cache / event-bus /
// workflow-engine / locking + session store, even when REDIS_URL is set for the
// dev box. The test runner tears the app down between/after tests while the
// Redis-backed BullMQ workers still have in-flight reconnects, raising a benign
// "Connection is closed" UNHANDLED rejection that Jest miscounts as a failed
// test (the #11 "9 of 15 FAILED" teardown flake). REDIS_URL stays set so the
// rate limiter's OWN ioredis client (src/api/utils/rate-limit.ts) and the
// rate-limit suites' connectTestRedisOrFail keep using the real rl:* keyspace.
const isIntegrationTest = Boolean(process.env.TEST_TYPE);

// File storage is env-gated: when S3/R2 credentials are present we register the
// S3 file provider (durable object storage + CDN), otherwise Medusa's built-in
// local provider is used (writes to static/ — fine for dev, lost on redeploy).
// Uploads always flow through POST /admin/media regardless of provider.
const s3Configured = Boolean(
  process.env.S3_BUCKET &&
  process.env.S3_ACCESS_KEY_ID &&
  process.env.S3_SECRET_ACCESS_KEY,
);
const fileModule = s3Configured
  ? [
      {
        resolve: '@medusajs/medusa/file',
        options: {
          providers: [
            {
              resolve: '@medusajs/file-s3',
              id: 's3',
              options: {
                file_url: process.env.S3_FILE_URL,
                access_key_id: process.env.S3_ACCESS_KEY_ID,
                secret_access_key: process.env.S3_SECRET_ACCESS_KEY,
                region: process.env.S3_REGION,
                bucket: process.env.S3_BUCKET,
                endpoint: process.env.S3_ENDPOINT,
                // Cloudflare R2 (and most S3-compatibles) need path-style URLs.
                additional_client_config: { forcePathStyle: true },
              },
            },
          ],
        },
      },
    ]
  : [];

// Redis-backed infra modules are env-gated, same pattern as fileModule above:
// with REDIS_URL present (production / distributed deploy) we register the Redis
// cache, event bus, workflow engine, and locking provider so the separate web
// and worker instances share one event queue, workflow state, cache, and lock
// namespace. Without REDIS_URL (local dev) Medusa's in-memory defaults stay
// active — single-process only, lost on restart, which is fine for dev.
// DO Managed Valkey serves TLS (rediss://) with a SELF-SIGNED CA that ioredis
// rejects by default — so every redis connection needs tls.rejectUnauthorized
// = false (encrypted, but skip CA verification of DO's own cert). Only applied
// for rediss:// URLs; a plain redis:// (local) gets no tls block. All four
// modules read redisUrl + redisOptions at the TOP level of options (the
// installed workflow-engine-redis reads top-level redisUrl, NOT a nested
// `redis:` object — that shape silently left it unconfigured).
const redisOptions = process.env.REDIS_URL?.startsWith('rediss://')
  ? { tls: { rejectUnauthorized: false } }
  : undefined;
const redisModules =
  process.env.REDIS_URL && !isIntegrationTest
    ? [
        {
          resolve: '@medusajs/medusa/cache-redis',
          options: { redisUrl: process.env.REDIS_URL, redisOptions },
        },
        {
          resolve: '@medusajs/medusa/event-bus-redis',
          options: { redisUrl: process.env.REDIS_URL, redisOptions },
        },
        {
          resolve: '@medusajs/medusa/workflow-engine-redis',
          // ODD ONE OUT: this loader destructures from `options.redis` (nested),
          // unlike cache/event-bus/locking which read redisUrl/redisOptions at the
          // top level. Top-level here throws "Cannot destructure property 'url' of
          // options.redis (undefined)". Keep redisUrl + redisOptions NESTED.
          options: { redis: { redisUrl: process.env.REDIS_URL, redisOptions } },
        },
        {
          resolve: '@medusajs/medusa/locking',
          options: {
            providers: [
              {
                resolve: '@medusajs/medusa/locking-redis',
                id: 'locking-redis',
                is_default: true,
                options: { redisUrl: process.env.REDIS_URL, redisOptions },
              },
            ],
          },
        },
      ]
    : [];
// Email delivery is env-gated, same pattern as fileModule/redisModules above: with
// RESEND_API_KEY + RESEND_FROM_EMAIL present we register the Resend provider on the
// `email` channel, otherwise the notification module keeps only the local/feed
// provider and email-channel sends are skipped by their callers (see
// subscribers/password-reset.ts, which shares this exact predicate — do NOT inline
// the check here, the two must never drift). Gating also keeps boot alive without
// the env: the provider's validateOptions THROWS on a missing api_key/from, which
// would crash startup, exactly like auth-google below.
const resendConfigured = isResendConfigured(process.env);

const secretFromEnv = (
  name: 'JWT_SECRET' | 'COOKIE_SECRET',
): string | undefined => {
  const value = process.env[name];
  if (isProduction && value === 'supersecret') {
    throw new Error(
      `${name} must be set to a strong random value in production (see .env.template)`,
    );
  }
  return value;
};

module.exports = defineConfig({
  // Bundled Medusa admin (/app) disabled — this Mercur project serves its own
  // admin (/dashboard) + vendor (/seller) dashboards via the *-ui modules below
  // (and the apps/admin + apps/vendor dev servers). Disabling avoids the default
  // admin loader requiring a bundled index.html at `medusa start`.
  admin: { disable: true },
  projectConfig: {
    databaseUrl: process.env.DATABASE_URL,
    // TLS for DO's self-signed CA, the per-process connection cap (an uncapped
    // pool overruns the 25-connection cluster during a deploy), and the
    // idle-in-transaction timeout. Every value, and why the keys sit where they
    // do, is documented in src/utils/db-driver-options.ts — that indirection
    // exists so the DB_POOL_MAX parse guard is unit-testable. Dev (localhost,
    // no TLS) leaves driver options untouched.
    ...(isProduction
      ? { databaseDriverOptions: productionDatabaseDriverOptions(process.env) }
      : {}),
    // Redis-backed sessions (express-session). Without redisUrl Medusa falls
    // back to an in-memory MemoryStore ("not designed for production" warning —
    // admin/vendor logins drop on every redeploy and aren't shared across
    // instances). redisOptions carries the self-signed-CA TLS opt for DO Valkey
    // (rediss://). Dev (no REDIS_URL) → MemoryStore, which is fine. Integration
    // tests use the MemoryStore too (see isIntegrationTest above).
    redisUrl: isIntegrationTest ? undefined : process.env.REDIS_URL,
    redisOptions,
    // worker mode splits the deploy: the web instance serves HTTP (server) while
    // a second instance drains the event/workflow queues (worker). DO App
    // Platform sets MEDUSA_WORKER_MODE per component; dev stays 'shared'
    // (one process does both). Requires the redisModules above to share state.
    workerMode:
      (process.env.MEDUSA_WORKER_MODE as
        | 'shared'
        | 'worker'
        | 'server'
        | undefined) ?? 'shared',
    http: {
      storeCors: process.env.STORE_CORS!,
      adminCors: process.env.ADMIN_CORS!,
      authCors: process.env.AUTH_CORS!,
      // @ts-expect-error: vendorCors is a Mercur extension key, not in Medusa's
      // http-config type. @mercurjs/core reads it at runtime in
      // src/api/utils/vendor-cors-middleware.ts (applied to /vendor/* via
      // src/api/vendor/middlewares.ts) — so this is live config, not dead.
      vendorCors: process.env.VENDOR_CORS!,
      jwtSecret: secretFromEnv('JWT_SECRET'),
      cookieSecret: secretFromEnv('COOKIE_SECRET'),
    },
  },
  featureFlags: {
    rbac: true,
    // Disabled (was the Mercur basic-starter default `true`): this is a
    // single-house-seller storefront (marketplace P2P is flag-gated off), so the
    // public /vendor/sellers self-registration surface is unused attack surface.
    // The house seller is seeded directly (scripts/seed.ts createSellers, status
    // OPEN), not via registration, so this is safe. Re-enable only as a
    // deliberate, audited choice if P2P vendor onboarding is ever built.
    seller_registration: false,
  },
  modules: [
    // Empty in dev (built-in local file provider stays active); registers the
    // S3 provider in prod when S3_* env is set.
    ...fileModule,
    // Empty in dev; registers Redis cache / event-bus / workflow-engine /
    // locking in prod when REDIS_URL is set (see redisModules above).
    ...redisModules,
    {
      resolve: '@medusajs/medusa/rbac',
    },
    // Auth module. Medusa registers an implicit default auth module with only the
    // `emailpass` provider (it's what powers /auth/customer|user|seller/emailpass
    // today — Mercur's core plugin adds NO auth providers). Declaring the module
    // explicitly REPLACES that default, so `emailpass` must be re-listed here or
    // every existing password login (customer, admin, vendor) breaks.
    //
    // `google` is added alongside for storefront customer social login — but ONLY
    // when its three env vars are present. auth-google's validateOptions THROWS on
    // a missing clientId/clientSecret/callbackUrl, which would crash boot; gating
    // it (same pattern as fileModule/redisModules above) keeps dev + un-provisioned
    // prod booting on emailpass alone, which is identical to today's default.
    // callbackUrl is the STOREFRONT page that receives the OAuth code (the
    // storefront also overrides it per-request via body.callback_url so one build
    // works local + prod); it must exactly match an Authorised redirect URI on the
    // Google OAuth client (Cloud project `polycards`).
    {
      resolve: '@medusajs/medusa/auth',
      options: {
        providers: [
          {
            resolve: '@medusajs/medusa/auth-emailpass',
            id: 'emailpass',
          },
          ...(process.env.GOOGLE_CLIENT_ID &&
          process.env.GOOGLE_CLIENT_SECRET &&
          process.env.GOOGLE_CALLBACK_URL
            ? [
                {
                  resolve: '@medusajs/auth-google',
                  id: 'google',
                  options: {
                    clientId: process.env.GOOGLE_CLIENT_ID,
                    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
                    callbackUrl: process.env.GOOGLE_CALLBACK_URL,
                  },
                },
              ]
            : []),
        ],
      },
    },
    {
      resolve: '@medusajs/medusa/notification',
      options: {
        providers: [
          {
            resolve: '@medusajs/medusa/notification-local',
            id: 'local',
            options: { channels: ['feed'] },
          },
          // Transactional email (password reset today). ABSOLUTE path for the same
          // reason as the packs module below: Medusa resolves `resolve` against
          // process.cwd(), so a relative './src/…' silently fails to load when this
          // config is require()d from apps/{admin,vendor} by the vite build.
          ...(resendConfigured
            ? [
                {
                  resolve: path.join(__dirname, 'src/modules/resend'),
                  id: 'resend',
                  options: {
                    channels: ['email'],
                    api_key: process.env.RESEND_API_KEY,
                    from: process.env.RESEND_FROM_EMAIL,
                    // Transactional mail sends from a noreply@ on the sending
                    // subdomain; without a reply-to, customer replies vanish.
                    reply_to: process.env.RESEND_REPLY_TO,
                  },
                },
              ]
            : []),
        ],
      },
    },
    {
      // Custom gacha Packs module — Phase 4 ships the Pack catalog model; the
      // gacha internals (odds/pulls) land in Phase 5. See src/modules/packs.
      // ABSOLUTE path (not './…'): Medusa resolves a module `resolve` string
      // against process.cwd(). A relative path therefore breaks when this config
      // is loaded from a DIFFERENT cwd — notably the admin/vendor vite build,
      // where mercurDashboardPlugin's loadMedusaConfig() require()s this file
      // from apps/{admin,vendor}; './src/modules/packs' resolves to
      // apps/*/src/modules/packs → not found → the plugin SILENTLY catches it
      // and drops pluginExtensions (and base). __dirname keeps it resolvable
      // from any cwd. See docs/pokenic-do-deploy-handoff.md §8.
      resolve: path.join(__dirname, 'src/modules/packs'),
    },
    {
      resolve: '@mercurjs/core/modules/admin-ui',
      options: {
        appDir: path.join(__dirname, '../../apps/admin'),
        path: '/dashboard',
      } as DashboardModuleOptions,
    },
    {
      resolve: '@mercurjs/core/modules/vendor-ui',
      options: {
        appDir: path.join(__dirname, '../../apps/vendor'),
        path: '/seller',
      } as DashboardModuleOptions,
    },
  ],
  plugins: [
    {
      resolve: '@mercurjs/core',
      options: {},
    },
  ],
});

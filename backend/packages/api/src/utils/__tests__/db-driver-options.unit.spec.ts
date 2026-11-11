import { ModulesSdkUtils } from '@medusajs/framework/utils';
import { parse } from 'pg-connection-string';
import {
  DEFAULT_DB_POOL_MAX,
  productionDatabaseDriverOptions,
  resolveDbPoolMax,
  runtimeDatabaseUrl,
} from '../db-driver-options';

describe('resolveDbPoolMax', () => {
  it('falls back to the default when DB_POOL_MAX is unset', () => {
    expect(resolveDbPoolMax({})).toBe(DEFAULT_DB_POOL_MAX);
  });

  // The failure this test exists for: a DO env var declared with an empty value
  // parses to 0, and `max: 0` hangs every acquire for 60s — a full outage on the
  // deploy that adds the cap. Never let this become Number(env.DB_POOL_MAX ?? 5).
  it.each([
    ['blank', ''],
    ['whitespace', '   '],
    ['non-numeric', 'abc'],
    ['zero', '0'],
    ['negative', '-4'],
  ])('rejects a %s DB_POOL_MAX rather than capping the pool at 0', (_l, v) => {
    expect(resolveDbPoolMax({ DB_POOL_MAX: v })).toBe(DEFAULT_DB_POOL_MAX);
  });

  // parseInt stops at the first non-digit. '1e3' written for 1000 would become
  // 1 — a pool of one serializes every query in the process. Falling back to
  // the default is always safe; silently honouring a prefix is not.
  it.each([
    ['decimal', '5.9'],
    ['exponent', '1e3'],
    ['trailing garbage', '5foo'],
    ['leading garbage', 'x5'],
  ])('rejects a %s DB_POOL_MAX instead of honouring its prefix', (_l, v) => {
    expect(resolveDbPoolMax({ DB_POOL_MAX: v })).toBe(DEFAULT_DB_POOL_MAX);
  });

  // All-digits but beyond Number.MAX_SAFE_INTEGER — would silently uncap the
  // pool this module exists to cap.
  it('rejects an unsafely large DB_POOL_MAX', () => {
    expect(resolveDbPoolMax({ DB_POOL_MAX: '9'.repeat(22) })).toBe(
      DEFAULT_DB_POOL_MAX,
    );
  });

  it('tolerates surrounding whitespace on an otherwise valid value', () => {
    expect(resolveDbPoolMax({ DB_POOL_MAX: ' 8 ' })).toBe(8);
  });

  it('honours a usable override', () => {
    expect(resolveDbPoolMax({ DB_POOL_MAX: '3' })).toBe(3);
  });
});

describe('productionDatabaseDriverOptions', () => {
  it('caps the pool and keeps TLS relaxed for DO’s self-signed CA', () => {
    expect(productionDatabaseDriverOptions({})).toEqual({
      connection: { ssl: { rejectUnauthorized: false } },
      pool: { min: 0, max: DEFAULT_DB_POOL_MAX },
      idle_in_transaction_session_timeout: 30_000,
    });
  });

  // Shape regression: `pool` and `idle_in_transaction_session_timeout` are read
  // off the TOP level of driverOptions by pg-connection-loader /
  // create-pg-connection. Nesting either inside `connection` type-checks and
  // silently does nothing, so assert against the real resolution path rather
  // than against our own object.
  it('resolves through Medusa’s loader to a capped knex pool', async () => {
    const driverOptions: Record<string, unknown> = {
      ...productionDatabaseDriverOptions({ DB_POOL_MAX: '4' }),
    };
    // pg-connection-loader.js:23-28 — lifts `pool` out, then forwards the rest.
    const pool = driverOptions.pool as { min: number; max: number };
    delete driverOptions.pool;

    const knex = ModulesSdkUtils.createPgConnection({
      clientUrl: 'postgres://u:p@127.0.0.1:5432/none',
      schema: 'public',
      driverOptions,
      pool: { min: pool.min, max: pool.max },
    }) as unknown as {
      client: {
        pool: { min: number; max: number };
        config: { connection: Record<string, unknown> };
      };
      destroy: () => Promise<void>;
    };

    try {
      expect(knex.client.pool.max).toBe(4);
      expect(knex.client.pool.min).toBe(0);
      expect(
        knex.client.config.connection.idle_in_transaction_session_timeout,
      ).toBe(30_000);
    } finally {
      await knex.destroy();
    }
  });
});

describe('runtimeDatabaseUrl (statement_timeout for long-running processes)', () => {
  const base = 'postgresql://u:p@db.example:25060/polycards';
  const optionsOf = (url: string | undefined) =>
    new URL(url as string).searchParams.get('options');

  it('adds a 60 s statement_timeout for `medusa start`', () => {
    const url = runtimeDatabaseUrl(base, {}, ['node', 'medusa', 'start']);
    expect(optionsOf(url)).toBe('-c statement_timeout=60000');
    // pg reads the same parameter it will send as the startup `options`.
    expect(parse(url as string).options).toBe('-c statement_timeout=60000');
  });

  it('leaves migrate, exec and every other command alone', () => {
    for (const cmd of ['db:migrate', 'exec', 'develop', 'user']) {
      expect(runtimeDatabaseUrl(base, {}, ['node', 'medusa', cmd])).toBe(base);
    }
  });

  it('keeps existing options and never doubles a timeout already on the URL', () => {
    const withOpts = `${base}?options=${encodeURIComponent('-c search_path=public')}`;
    expect(optionsOf(runtimeDatabaseUrl(withOpts, {}, ['x', 'medusa', 'start']))).toBe(
      '-c search_path=public -c statement_timeout=60000',
    );
    const already = `${base}?options=${encodeURIComponent('-c statement_timeout=5000')}`;
    expect(runtimeDatabaseUrl(already, {}, ['x', 'medusa', 'start'])).toBe(already);
  });

  it('honours DB_STATEMENT_TIMEOUT_MS, and 0 turns it off', () => {
    const argv = ['x', 'medusa', 'start'];
    expect(optionsOf(runtimeDatabaseUrl(base, { DB_STATEMENT_TIMEOUT_MS: '90000' }, argv))).toBe(
      '-c statement_timeout=90000',
    );
    expect(runtimeDatabaseUrl(base, { DB_STATEMENT_TIMEOUT_MS: '0' }, argv)).toBe(base);
    // Junk falls back to the default rather than disabling the guard.
    expect(optionsOf(runtimeDatabaseUrl(base, { DB_STATEMENT_TIMEOUT_MS: '1e3' }, argv))).toBe(
      '-c statement_timeout=60000',
    );
  });

  it('passes an unset URL through', () => {
    expect(runtimeDatabaseUrl(undefined, {}, ['x', 'medusa', 'start'])).toBeUndefined();
  });
});

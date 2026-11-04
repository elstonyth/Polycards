import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils';
import { Migration20261104120000 } from '../../src/modules/packs/migrations/Migration20261104120000';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { clearProfileCache } from '../../src/api/store/profiles/[handle]/route';
import { unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

// Migration20261104120000 against the four shapes production held on
// 2026-11-04. The suite's own migrate run happens on an empty table, which
// proves the SQL parses and nothing else; the risk is in the rows.

type Knex = {
  raw: (
    sql: string,
    bindings?: unknown[],
  ) => Promise<{ rows: Record<string, unknown>[] }>;
};

async function upSql(): Promise<string[]> {
  const sql: string[] = [];
  const m = Object.create(Migration20261104120000.prototype) as {
    addSql: (s: string) => void;
    up: () => Promise<void>;
  };
  m.addSql = (s) => sql.push(s);
  await m.up();
  return sql;
}

const STANDARD = /^Collector\d{4,6}$/;

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('8-digit handle backfill (Migration20261104120000)', () => {
      it('gives each 8-digit account a standard name and handle, and keeps the old link', async () => {
        clearProfileCache();
        const container = getContainer();
        const knex = container.resolve(
          ContainerRegistrationKeys.PG_CONNECTION,
        ) as unknown as Knex;
        const customers = container.resolve(Modules.CUSTOMER);
        const bank = [{ id: 'acct_1', bankCode: 'MBB', last4: '1234' }];
        const ids: string[] = [];

        const [both, split, ownName, noHandle, holder, arrayBlob, normal] =
          await customers.createCustomers([
            {
              // A: name and handle both 8 digits.
              email: 'hb-both@test.dev',
              first_name: 'Collector11112222',
              metadata: { handle: 'Collector11112222', bank_accounts: bank },
            },
            {
              // B: the name was free, the handle was not, so they split.
              email: 'hb-split@test.dev',
              first_name: 'Collector3333',
              metadata: { handle: 'Collector33334444' },
            },
            {
              // C: renamed to a name of their own.
              email: 'hb-own@test.dev',
              first_name: 'MOONBREON',
              metadata: { handle: 'Collector55556666', avatar_url: '/a.webp' },
            },
            {
              // D: 8-digit name, never opened a profile, no handle yet.
              email: 'hb-nohandle@test.dev',
              first_name: 'Collector77778888',
            },
            {
              // Holds Collector3333 as a handle: why B split.
              email: 'hb-holder@test.dev',
              first_name: 'Renamed_Away',
              metadata: { handle: 'Collector3333' },
            },
            { email: 'hb-array@test.dev', first_name: 'Collector99990000' },
            {
              email: 'hb-normal@test.dev',
              first_name: 'Collector1234',
              metadata: { handle: 'Collector1234' },
            },
          ]);
        await knex.raw(
          `update customer set metadata = '[1, 2]'::jsonb where id = ?`,
          [arrayBlob.id],
        );
        const [gone] = await customers.createCustomers([
          {
            email: 'hb-gone@test.dev',
            first_name: 'Collector12123434',
            metadata: { handle: 'Collector12123434' },
          },
        ]);
        await customers.softDeleteCustomers([gone.id]);

        // The retry path, which is the common one on prod (half the 4-digit
        // numbers are taken): every 4-digit try of this row is held by
        // someone, so it must move on to 5 digits.
        const [crowded, typedCollector, gap] = await customers.createCustomers([
          {
            email: 'hb-crowded@test.dev',
            first_name: 'Collector24246868',
            metadata: { handle: 'Collector24246868' },
          },
          {
            // C with a Collector-shaped name the player typed: the handle did
            // not grow from it, so the name is theirs and stays.
            email: 'hb-typed-collector@test.dev',
            first_name: 'Collector5555',
            metadata: { handle: 'Collector13135757' },
          },
          {
            // E: a 4-digit generated name, no handle yet, and the name is
            // already someone else's handle.
            email: 'hb-gap@test.dev',
            first_name: 'Collector5151',
          },
        ]);
        const tries = await knex.raw(
          `select distinct 'Collector' || lpad((((hashtextextended(? || '#' || n, 1104) & 9223372036854775807) % 10000))::text, 4, '0') as c from generate_series(0, 7) n`,
          [crowded.id],
        );
        const held = tries.rows.map((t) => String(t.c));
        await customers.createCustomers([
          // A try that is already a seeded handle is held anyway.
          ...held
            .filter(
              (h) =>
                ![
                  'Collector3333',
                  'Collector1234',
                  'Collector5151',
                  'Collector5555',
                ].includes(h),
            )
            .map((h, i) => ({
            email: `hb-held-${i}@test.dev`,
            first_name: `Held_${i}`,
            metadata: { handle: h },
          })),
          {
            email: 'hb-gap-holder@test.dev',
            first_name: 'Gap_Holder',
            metadata: { handle: 'Collector5151' },
          },
        ]);
        ids.push(crowded.id, typedCollector.id, gap.id);

        for (const statement of await upSql()) await knex.raw(statement);

        ids.unshift(
          both.id,
          split.id,
          ownName.id,
          noHandle.id,
          holder.id,
          arrayBlob.id,
          normal.id,
          gone.id,
        );
        const read = async () => {
          const { rows } = await knex.raw(
            `select id, first_name, metadata from customer where id in (${ids.map(() => '?').join(', ')})`,
            ids,
          );
          return (id: string) =>
            rows.find((r) => r.id === id) as {
              first_name: string;
              metadata: Record<string, unknown>;
            };
        };
        const row = await read();

        // A: both move to one standard value; the old handle is the alias and
        // the rest of the blob is merged, not replaced.
        const a = row(both.id);
        expect(a.first_name).toMatch(STANDARD);
        expect(a.metadata).toEqual({
          handle: a.first_name,
          handle_alias: 'Collector11112222',
          name_before_handle_backfill: 'Collector11112222',
          bank_accounts: bank,
        });
        // B: name and handle match again, and neither is the holder's.
        const b = row(split.id);
        expect(b.first_name).toMatch(STANDARD);
        expect(b.first_name).not.toBe('Collector3333');
        expect(b.metadata).toEqual({
          handle: b.first_name,
          handle_alias: 'Collector33334444',
          name_before_handle_backfill: 'Collector3333',
        });
        // C: their own name stays; only the handle moves.
        const c = row(ownName.id);
        expect(c.first_name).toBe('MOONBREON');
        expect(c.metadata.handle).toMatch(STANDARD);
        expect(c.metadata).toMatchObject({
          handle_alias: 'Collector55556666',
          avatar_url: '/a.webp',
        });
        expect(c.metadata).not.toHaveProperty('name_before_handle_backfill');
        // D: only the name; the handle is still frozen on first login.
        const d = row(noHandle.id);
        expect(d.first_name).toMatch(STANDARD);
        expect(d.metadata).toEqual({
          name_before_handle_backfill: 'Collector77778888',
        });
        // Untouched: the holder, a non-object blob, a normal account, and a
        // deleted one.
        expect(row(holder.id).metadata).toEqual({ handle: 'Collector3333' });
        expect(row(arrayBlob.id).metadata).toEqual([1, 2]);
        expect(row(normal.id).metadata).toEqual({ handle: 'Collector1234' });
        expect(row(gone.id).first_name).toBe('Collector12123434');

        const crowdedRow = row(crowded.id);
        expect(crowdedRow.first_name).toMatch(/^Collector\d{5}$/);
        expect(crowdedRow.metadata.handle).toBe(crowdedRow.first_name);
        expect(held).not.toContain(crowdedRow.first_name);
        const typedRow = row(typedCollector.id);
        expect(typedRow.first_name).toBe('Collector5555');
        expect(typedRow.metadata.handle).toMatch(STANDARD);
        expect(typedRow.metadata).toMatchObject({
          handle_alias: 'Collector13135757',
        });
        expect(typedRow.metadata).not.toHaveProperty(
          'name_before_handle_backfill',
        );
        const gapRow = row(gap.id);
        expect(gapRow.first_name).toMatch(STANDARD);
        expect(gapRow.first_name).not.toBe('Collector5151');
        expect(gapRow.metadata).toEqual({
          name_before_handle_backfill: 'Collector5151',
        });

        // Every new value is different from every other.
        const fresh = [a.first_name, b.first_name, c.metadata.handle, d.first_name];
        expect(new Set(fresh.map((v) => String(v).toLowerCase())).size).toBe(4);

        // Re-running is a no-op, which is what a retried deploy does.
        for (const statement of await upSql()) await knex.raw(statement);
        const again = await read();
        for (const id of ids) expect(again(id)).toEqual(row(id));

        // The old links still find the player and answer with the new handle
        // (the storefront redirects on that); the new links work too.
        const apiKeys = container.resolve(Modules.API_KEY);
        const key = await apiKeys.createApiKeys({
          title: 'handle-backfill-test',
          type: 'publishable',
          created_by: 'handle-backfill-test',
        });
        const get = (h: string) =>
          unwrapResponse(
            api.get(`/store/profiles/${h}`, {
              headers: { 'x-publishable-api-key': key.token },
            }),
          );
        const old = await get('collector11112222');
        expect(old.status).toBe(200);
        expect(old.data.handle).toBe(a.first_name);
        expect((await get('Collector55556666')).data.handle).toBe(
          c.metadata.handle,
        );
        expect((await get(a.first_name)).status).toBe(200);

        // Nobody else can take an old handle, as a handle or a name.
        const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
        const [newcomer] = await customers.createCustomers([
          { email: 'hb-newcomer@test.dev', first_name: 'Newcomer_Player' },
        ]);
        const handle = await packs.claimHandle({
          customerId: newcomer.id,
          desired: 'Collector11112222',
        });
        expect(handle.toLowerCase()).not.toBe('collector11112222');
        const name = await packs.claimUsername({
          customerId: newcomer.id,
          desired: 'Collector33334444',
        });
        expect(name.toLowerCase()).not.toBe('collector33334444');
      });
    });
  },
});

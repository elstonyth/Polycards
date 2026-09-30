import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils';
import { Migration20260930140000 } from '../../src/modules/packs/migrations/Migration20260930140000';
import { clearProfileCache } from '../../src/api/store/profiles/[handle]/route';
import { unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

// Migration20260930140000 against the data shapes production actually holds.
// The suite's own migrate run happens on an empty table, which proves the SQL
// parses and nothing else — the backfill's whole risk is in rows: a merge that
// clobbers the payout accounts beside the handle, a pre-2026-09-04 slug
// surviving as someone's permanent address, or the unique index refusing to
// build over a stale slug that equals another player's current name.

type Knex = {
  raw: (
    sql: string,
    bindings?: unknown[],
  ) => Promise<{ rows: Record<string, unknown>[] }>;
};

async function upSql(): Promise<string[]> {
  const sql: string[] = [];
  const m = Object.create(Migration20260930140000.prototype) as {
    addSql: (s: string) => void;
    up: () => Promise<void>;
  };
  m.addSql = (s) => sql.push(s);
  await m.up();
  return sql;
}

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('profile handle backfill (Migration20260930140000)', () => {
      it('freezes each live name as its handle, merging into the blob and dropping stale slugs', async () => {
        clearProfileCache();
        const container = getContainer();
        const knex = container.resolve(
          ContainerRegistrationKeys.PG_CONNECTION,
        ) as unknown as Knex;
        const customers = container.resolve(Modules.CUSTOMER);

        // Back to the pre-migration state: no index yet, so a stale slug may
        // collide with another player's current name, as it can in production.
        await knex.raw(
          'drop index if exists "IDX_customer_handle_lower_unique"',
        );

        const bank = [{ id: 'acct_1', bankCode: 'MBB', last4: '1234' }];
        const [renamed, nameless, fresh, legacyHolder, nameOwner, arrayBlob] =
          await customers.createCustomers([
            {
              // Signed up as "Wei Nguan", renamed to MOONBREON: the old slug is a
              // real name, and must not become their permanent address.
              email: 'bf-renamed@test.dev',
              first_name: 'MOONBREON',
              metadata: {
                handle: 'wei-nguan-5ren',
                bank_accounts: bank,
                referral_code: 'ABCD2345',
                avatar_url: '/a.webp',
              },
            },
            {
              email: 'bf-nameless@test.dev',
              first_name: null,
              metadata: { handle: 'tan-9m6q', avatar_url: '/b.webp' },
            },
            { email: 'bf-fresh@test.dev', first_name: 'Collector6167' },
            {
              email: 'bf-legacy@test.dev',
              first_name: 'eric',
              metadata: { handle: 'john-tbml' },
            },
            // Holds, as a NAME, the slug the row above holds as a stale handle.
            { email: 'bf-owner@test.dev', first_name: 'john-tbml' },
            { email: 'bf-array@test.dev', first_name: 'ArrayBlob' },
          ]);
        await knex.raw(
          `update customer set metadata = '[1, 2]'::jsonb where id = ?`,
          [arrayBlob.id],
        );
        const [gone] = await customers.createCustomers([
          {
            email: 'bf-gone@test.dev',
            first_name: 'Gone_Player',
            metadata: { handle: 'gone-slug' },
          },
        ]);
        await customers.softDeleteCustomers([gone.id]);

        for (const statement of await upSql()) await knex.raw(statement);

        const ids = [
          renamed.id,
          nameless.id,
          fresh.id,
          legacyHolder.id,
          nameOwner.id,
          arrayBlob.id,
          gone.id,
        ];
        const { rows } = await knex.raw(
          `select id, metadata from customer where id in (${ids.map(() => '?').join(', ')})`,
          ids,
        );
        const metaOf = (id: string) => rows.find((r) => r.id === id)?.metadata;

        // Merged, not replaced: the payout accounts, referral code and avatar
        // sit in the same blob.
        expect(metaOf(renamed.id)).toEqual({
          handle: 'MOONBREON',
          bank_accounts: bank,
          referral_code: 'ABCD2345',
          avatar_url: '/a.webp',
        });
        // No usable name: the stale slug is removed, not inherited.
        expect(metaOf(nameless.id)).toEqual({ avatar_url: '/b.webp' });
        expect(metaOf(fresh.id)).toEqual({ handle: 'Collector6167' });
        expect(metaOf(legacyHolder.id)).toEqual({ handle: 'eric' });
        expect(metaOf(nameOwner.id)).toEqual({ handle: 'john-tbml' });
        // Not an object: left exactly as found (|| would have appended).
        expect(metaOf(arrayBlob.id)).toEqual([1, 2]);
        // Deleted accounts are outside the index and untouched.
        expect(metaOf(gone.id)).toEqual({ handle: 'gone-slug' });

        const index = await knex.raw(
          `select indexdef from pg_indexes where indexname = 'IDX_customer_handle_lower_unique'`,
        );
        expect(index.rows).toHaveLength(1);

        // Re-running is a no-op, which is what a retried deploy does.
        for (const statement of await upSql()) await knex.raw(statement);
        const again = await knex.raw(
          'select metadata from customer where id = ?',
          [renamed.id],
        );
        expect(again.rows[0].metadata).toEqual(metaOf(renamed.id));

        // And the URLs: the name each player held resolves to them; the dead
        // slugs do not.
        const apiKeys = container.resolve(Modules.API_KEY);
        const key = await apiKeys.createApiKeys({
          title: 'backfill-test',
          type: 'publishable',
          created_by: 'backfill-test',
        });
        const get = (h: string) =>
          unwrapResponse(
            api.get(`/store/profiles/${h}`, {
              headers: { 'x-publishable-api-key': key.token },
            }),
          );
        expect((await get('Collector6167')).status).toBe(200);
        expect((await get('moonbreon')).data.handle).toBe('MOONBREON');
        expect((await get('john-tbml')).data.name).toBe('john-tbml');
        expect((await get('wei-nguan-5ren')).status).toBe(404);
        expect((await get('tan-9m6q')).status).toBe(404);
      });
    });
  },
});

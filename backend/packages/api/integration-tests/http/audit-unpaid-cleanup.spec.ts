import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { ContainerRegistrationKeys } from '@medusajs/framework/utils';
import { Migration20261014120000 } from '../../src/modules/packs/migrations/Migration20261014120000';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';

jest.setTimeout(240 * 1000);

// Migration20261014120000 against the notes production holds. The suite's own
// migrate run happens on an empty table, which proves the SQL parses and
// nothing else: the risk is clearing a real finding along with the noise.

type Knex = {
  raw: (
    sql: string,
    bindings?: unknown[],
  ) => Promise<{ rows: Record<string, unknown>[] }>;
};

async function upSql(): Promise<string[]> {
  const sql: string[] = [];
  const m = Object.create(Migration20261014120000.prototype) as {
    addSql: (s: string) => void;
    up: () => Promise<void>;
  };
  m.addSql = (s) => sql.push(s);
  await m.up();
  return sql;
}

const UNPAID = 'gateway still reports pending for a row we marked expired';

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ getContainer }) => {
    describe('audit unpaid-note cleanup (Migration20261014120000)', () => {
      it('clears only the "never paid" note on expired top-ups', async () => {
        const container = getContainer();
        const knex = container.resolve(
          ContainerRegistrationKeys.PG_CONNECTION,
        ) as unknown as Knex;
        const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
        const row = (id: string, status: string, audit_note: string) => ({
          merchant_transaction_id: id,
          customer_id: 'cus_audit_cleanup',
          amount_requested: 50,
          amount_settled: status === 'settled' ? 50 : null,
          payment_method_code: 'BQR',
          status,
          audit_note,
        });
        await packs.createGatewayDeposits([
          row('PC-unpaid', 'expired', UNPAID),
          // Real findings, all kept.
          row(
            'PC-paid-late',
            'expired',
            'gateway says PAID (50.00) but the row is expired — customer paid and was not credited',
          ),
          row(
            'PC-failed-pending',
            'failed',
            'gateway still reports pending for a row we marked failed',
          ),
          row('PC-short', 'settled', 'gateway paid 49.00, row credited 50.00'),
        ] as never);

        for (const sql of await upSql()) await knex.raw(sql);

        const { rows } = await knex.raw(
          `SELECT merchant_transaction_id AS id, audit_note FROM gateway_deposit
            WHERE customer_id = 'cus_audit_cleanup' ORDER BY merchant_transaction_id`,
        );
        expect(rows).toEqual([
          {
            id: 'PC-failed-pending',
            audit_note: expect.stringMatching(/failed/),
          },
          { id: 'PC-paid-late', audit_note: expect.stringMatching(/PAID/) },
          { id: 'PC-short', audit_note: expect.stringMatching(/49\.00/) },
          { id: 'PC-unpaid', audit_note: null },
        ]);
      });
    });
  },
});

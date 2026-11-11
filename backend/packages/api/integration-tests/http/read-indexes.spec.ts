import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { ContainerRegistrationKeys } from '@medusajs/framework/utils';

jest.setTimeout(240 * 1000);

// Migration20261111180000 (audit 2026-11-11 LOW list): pull.open_id and the
// settled coin-flip feed had no index. A partial index only helps a query
// whose WHERE implies its predicate, so each case runs the readers' own shape
// through EXPLAIN with sequential scans priced out, and checks the planner can
// pick the new index for it.

type Knex = {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  transaction: <T>(fn: (trx: Knex) => Promise<T>) => Promise<T>;
};

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ getContainer }) => {
    const pg = () =>
      getContainer().resolve(ContainerRegistrationKeys.PG_CONNECTION) as Knex;

    const plan = (sql: string, bindings: unknown[] = []) =>
      pg().transaction(async (trx) => {
        await trx.raw('SET LOCAL enable_seqscan = off');
        const { rows } = await trx.raw(`EXPLAIN ${sql}`, bindings);
        return rows.map((r) => String(r['QUERY PLAN'])).join('\n');
      });

    it('creates both indexes', async () => {
      const { rows } = await pg().raw(
        `SELECT indexname FROM pg_indexes WHERE indexname IN ('IDX_pull_open_id', 'IDX_coin_flip_round_settled') ORDER BY indexname`,
      );
      expect(rows.map((r) => r.indexname)).toEqual([
        'IDX_coin_flip_round_settled',
        'IDX_pull_open_id',
      ]);
    });

    it('serves the open_id lookups from IDX_pull_open_id', async () => {
      // refundUnfinishedOpen's prize check.
      expect(
        await plan(
          'SELECT 1 AS x FROM pull WHERE open_id = ? AND deleted_at IS NULL LIMIT 1',
          ['open_1'],
        ),
      ).toContain('IDX_pull_open_id');
    });

    it('serves the recent settled flips from IDX_coin_flip_round_settled', async () => {
      // The ORM's shape for listCoinFlipRounds({ status: ['won', 'lost'] },
      // { order: { settled_at: 'DESC', id: 'DESC' }, take: 40 }).
      expect(
        await plan(
          `SELECT * FROM coin_flip_round WHERE status IN (?, ?) AND deleted_at IS NULL ORDER BY settled_at DESC, id DESC LIMIT 40`,
          ['won', 'lost'],
        ),
      ).toContain('IDX_coin_flip_round_settled');
    });
  },
});

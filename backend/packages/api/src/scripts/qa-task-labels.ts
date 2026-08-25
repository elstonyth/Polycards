import type { ExecArgs } from '@medusajs/framework/types';
import { PACKS_MODULE } from '../modules/packs';
import type PacksModuleService from '../modules/packs/service';
import { resolveTaskLabels } from '../api/admin/tasks/labels';

/**
 * One-off QA read: what the admin Tasks console will actually render for the
 * tasks in THIS database. The unit spec pins the formatting against a stub;
 * this proves the lookups resolve against real pack / card / pixel rows.
 *
 *   ./node_modules/.bin/medusa exec ./src/scripts/qa-task-labels.ts
 */
export default async function qaTaskLabels({ container }: ExecArgs) {
  const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
  const rows = await packs.listTaskDefinitions(
    {},
    { order: { sort: 'ASC' }, take: 500 },
  );
  const labels = await resolveTaskLabels(packs, rows);
  // eslint-disable-next-line no-console
  console.log(`\n${rows.length} task(s):\n`);
  for (const t of rows) {
    const l = labels.get(t.id)!;
    // eslint-disable-next-line no-console
    console.log(
      [
        `  ${t.kind.padEnd(11)} #${String(t.sort).padEnd(3)} ${t.active ? 'active ' : 'retired'}`,
        `    title : ${t.title}`,
        `    goal  : ${l.requirement}`,
        `    reward: ${l.reward}`,
        `    runs  : ${t.starts_at ?? 'always'} → ${t.ends_at ?? 'always'}`,
      ].join('\n'),
    );
  }
  // eslint-disable-next-line no-console
  console.log('');
}

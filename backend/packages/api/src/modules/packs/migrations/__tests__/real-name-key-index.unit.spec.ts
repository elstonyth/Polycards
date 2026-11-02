import { realNameKeySql } from '../../../../utils/real-name';
import { Migration20261103190000 } from '../Migration20261103190000';

// The lookup only uses this index if both spell the expression the same way.
test('indexes exactly the expression setRealName queries', async () => {
  const sql: string[] = [];
  const m = Object.create(
    Migration20261103190000.prototype,
  ) as Migration20261103190000 & { addSql: (s: string) => void };
  m.addSql = (s: string) => sql.push(s);
  await m.up();
  expect(sql.join('\n')).toContain(`(${realNameKeySql('real_name')})`);
});

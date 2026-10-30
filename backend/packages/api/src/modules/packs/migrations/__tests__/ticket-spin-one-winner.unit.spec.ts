import fs from 'fs';
import path from 'path';
import { Migration20261030100000 } from '../Migration20261030100000';
import { Migration20261030110000 } from '../Migration20261030110000';

/**
 * The two hand-written migrations cross-checked against the hand-edited
 * .snapshot-packs.json, the only thing that ties them together: every column and
 * index the snapshot declares for the new tables must be emitted, the indexes
 * verbatim. lucky_draw_event / _entry / _ticket have never been in the snapshot,
 * so their changes are pinned by the HTTP spec instead
 * (ticket-spin-one-winner-schema.spec.ts).
 */
type Snapshot = {
  tables: {
    name: string;
    columns: Record<string, { default?: string; enumItems?: string[] }>;
    indexes: { keyName: string; expression?: string }[];
  }[];
};
type Emitter = { addSql: (s: string) => void; up(): Promise<void>; down(): Promise<void> };

async function emit(prototype: object, dir: 'up' | 'down'): Promise<string[]> {
  const sql: string[] = [];
  const m = Object.create(prototype) as Emitter;
  m.addSql = (s) => sql.push(s);
  await m[dir]();
  return sql;
}

const table = (name: string): Snapshot['tables'][number] => {
  const snapshot = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', '.snapshot-packs.json'), 'utf8'),
  ) as Snapshot;
  const t = snapshot.tables.find((x) => x.name === name);
  if (!t) throw new Error(`${name} missing from the snapshot`);
  return t;
};

const SPIN = Migration20261030100000.prototype;
const ONE_WINNER = Migration20261030110000.prototype;

describe.each([
  ['ticket_prize', SPIN],
  ['ticket_spin', SPIN],
  ['lucky_draw_event_result', ONE_WINNER],
])('%s', (name, prototype) => {
  test('up() creates every snapshot column', async () => {
    const create = (await emit(prototype, 'up')).find((s) =>
      s.startsWith(`create table if not exists "${name}"`),
    )!;
    for (const col of Object.keys(table(name).columns)) {
      expect(create).toContain(`"${col}"`);
    }
    expect(create).toContain(`constraint "${name}_pkey"`);
  });

  test('up() emits exactly the indexes the snapshot declares', async () => {
    const emitted = (await emit(prototype, 'up')).filter((s) =>
      new RegExp(`CREATE (UNIQUE )?INDEX .* ON "${name}"`).test(s),
    );
    const declared = table(name)
      .indexes.filter((i) => i.expression)
      .map((i) => `${i.expression};`);
    expect(emitted.sort()).toEqual(declared.sort());
  });
});

test('pack.prize_type in the snapshot matches what up() adds', async () => {
  const col = table('pack').columns.prize_type;
  expect(col.default).toBe("'cards'");
  expect(col.enumItems).toEqual(['cards', 'tickets']);
  expect(await emit(SPIN, 'up')).toContain(
    `alter table if exists "pack" add column if not exists "prize_type" text check ("prize_type" in ('cards', 'tickets')) not null default 'cards';`,
  );
});

test.each([
  ['ticket spin', SPIN],
  ['one winner', ONE_WINNER],
])(
  '%s: up() takes the lock timeout first, down() refuses before it changes anything',
  async (_label, prototype) => {
    expect((await emit(prototype, 'up'))[0]).toBe(
      "set local lock_timeout = '5s';",
    );
    expect((await emit(prototype, 'down'))[0]).toMatch(
      /^DO \$\$[\s\S]*RAISE EXCEPTION/,
    );
  },
);

test('neither up() rewrites or backfills a row', async () => {
  const sql = [...(await emit(SPIN, 'up')), ...(await emit(ONE_WINNER, 'up'))];
  for (const statement of sql) {
    expect(statement).not.toMatch(/\b(update|delete from)\b/i);
  }
});

import { Migration20261021120000 } from '../Migration20261021120000';

// pixel_pokemon.franchise + number: existing rows must become Pokémon without
// a table rewrite, and the One Piece numbering is unique per franchise among
// base ('normal') rows only — variants share their character's number.

async function emit(dir: 'up' | 'down'): Promise<string> {
  const sql: string[] = [];
  const m = Object.create(
    Migration20261021120000.prototype,
  ) as Migration20261021120000 & { addSql: (s: string) => void };
  m.addSql = (s: string) => sql.push(s);
  await m[dir]();
  return sql.join('\n').replace(/\s+/g, ' ');
}

test('up() adds franchise (default pokemon), a nullable number, and the per-franchise unique index', async () => {
  const sql = await emit('up');
  expect(sql.startsWith("set local lock_timeout = '5s';")).toBe(true);
  expect(sql).toContain(
    `add column if not exists "franchise" text not null default 'pokemon';`,
  );
  expect(sql).toContain(`add column if not exists "number" integer null;`);
  expect(sql).toContain(
    `create unique index if not exists "UQ_pixel_pokemon_franchise_number_normal" on "pixel_pokemon" ("franchise", "number") where variant = 'normal' and number is not null and deleted_at is null;`,
  );
  // existing rows are Pokémon via the column default — no backfill UPDATE
  expect(sql).not.toMatch(/\bupdate\b/i);
  // the decks never cross at the DB: no number on a Pokémon, no dex elsewhere
  expect(sql).toContain(
    `add constraint "pixel_pokemon_deck_numbering_check" check (("franchise" = 'pokemon' and "number" is null) or ("franchise" <> 'pokemon' and "dex" is null));`,
  );
});

test('down() drops the check, the index and both columns', async () => {
  const sql = await emit('down');
  expect(sql).toContain(
    'drop constraint if exists "pixel_pokemon_deck_numbering_check"',
  );
  expect(sql).toContain(
    'drop index if exists "UQ_pixel_pokemon_franchise_number_normal"',
  );
  expect(sql).toContain('drop column if exists "number"');
  expect(sql).toContain('drop column if exists "franchise"');
});

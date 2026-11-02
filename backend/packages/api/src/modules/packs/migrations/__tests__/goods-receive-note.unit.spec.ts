import * as migrationModule from '../Migration20261028150000';

const { Migration20261028150000 } = migrationModule;

// Pins the SQL Migration20261028150000 emits (spec 2026-10-28): the GRN
// tables + sequence, purchase_invoice.from_grn_id and its once-only index,
// and the stock_movement kind widening. The admin_action_audit CHECK lists
// are pinned by admin-audit-config-enums.unit.spec.ts.
async function emitted(dir: 'up' | 'down'): Promise<string> {
  const sql: string[] = [];
  const m = Object.create(Migration20261028150000.prototype) as InstanceType<
    typeof Migration20261028150000
  > & { addSql: (s: string) => void };
  m.addSql = (s: string) => sql.push(s);
  await m[dir]();
  return sql.join('\n');
}

describe('Migration20261028150000 (goods receive notes)', () => {
  it('creates both GRN tables and the display-number sequence', async () => {
    const up = await emitted('up');
    expect(up).toMatch(/create table if not exists "goods_receive_note" \(/);
    expect(up).toMatch(/"reverses_grn_id" text null/);
    expect(up).toMatch(
      /create table if not exists "goods_receive_note_line" \(/,
    );
    expect(up).toMatch(/"fmv_snapshot" numeric not null/);
    expect(up).toMatch(
      /CREATE SEQUENCE IF NOT EXISTS "goods_receive_note_seq" START 1;/,
    );
  });

  it('lets a GRN be reversed only once', async () => {
    const up = await emitted('up');
    expect(up).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS "IDX_goods_receive_note_reverses_unique" ON "goods_receive_note" \("reverses_grn_id"\) WHERE deleted_at IS NULL AND reverses_grn_id IS NOT NULL;/,
    );
  });

  it('adds purchase_invoice.from_grn_id with a plain lookup index (one LIVE transfer is enforced under the GRN lock, not by a unique index)', async () => {
    const up = await emitted('up');
    expect(up).toMatch(
      /alter table if exists "purchase_invoice" add column if not exists "from_grn_id" text null;/,
    );
    expect(up).toMatch(
      /CREATE INDEX IF NOT EXISTS "IDX_purchase_invoice_from_grn_id" ON "purchase_invoice" \("from_grn_id"\) WHERE deleted_at IS NULL AND from_grn_id IS NOT NULL;/,
    );
    expect(up).not.toMatch(/UNIQUE INDEX[^;]*purchase_invoice/);
  });

  it("widens stock_movement.kind with 'goods_receive'", async () => {
    const up = await emitted('up');
    const hit = up.match(
      /stock_movement_kind_check" check\("kind" in \(([^)]*)\)\)/,
    );
    expect(hit).not.toBeNull();
    expect([...hit![1].matchAll(/'([^']+)'/g)].map((x) => x[1])).toEqual([
      'purchase',
      'pull',
      'vault_out',
      'requested',
      'shipped',
      'completed',
      'adjustment',
      'goods_receive',
    ]);
  });

  it('refuses to unwind while GRN rows exist', async () => {
    const down = await emitted('down');
    expect(down).toMatch(/RAISE EXCEPTION/);
    expect(down).toMatch(/goods_receive_note/);
  });
});

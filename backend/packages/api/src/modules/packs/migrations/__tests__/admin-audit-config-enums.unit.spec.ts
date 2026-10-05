import {
  ADMIN_AUDIT_ACTIONS,
  ADMIN_AUDIT_ENTITY_TYPES,
} from '../../models/admin-action-audit';
// Always the LATEST migration that rewrites the CHECKs (each one re-emits the
// full lists): Migration20261006110000 added 'announcement'.
import * as migrationModule from '../Migration20261006110000';

const { Migration20261006110000 } = migrationModule;

// The DB CHECKs on admin_action_audit are only rewritten by an explicit
// migration (Migration20260906090000 learned this the hard way). A value the
// model allows but the CHECK does not makes every write that uses it fail —
// and with config changes audited as the LAST workflow step, that failure
// rolls the operator's pack/odds save back. Keep the two lists identical.
//
// Read from the SQL the migration actually emits (the lists themselves cannot
// be exported: the migration loader takes a file's first export as its class).

async function checkLists(): Promise<Record<string, string[]>> {
  const sql: string[] = [];
  const m = Object.create(Migration20261006110000.prototype) as InstanceType<
    typeof Migration20261006110000
  > & {
    addSql: (s: string) => void;
  };
  m.addSql = (s: string) => sql.push(s);
  await m.up();
  const lists: Record<string, string[]> = {};
  for (const s of sql) {
    const hit = s.match(/check\("(\w+)" in \(([^)]*)\)\)/);
    if (hit)
      lists[hit[1]] = [...hit[2].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  }
  return lists;
}

describe('admin_action_audit CHECK lists (config-change audit)', () => {
  it('allows exactly the entity types the model declares', async () => {
    const { entity_type } = await checkLists();
    expect([...entity_type].sort()).toEqual(
      [...ADMIN_AUDIT_ENTITY_TYPES].sort(),
    );
  });

  it('allows exactly the actions the model declares', async () => {
    const { action } = await checkLists();
    expect([...action].sort()).toEqual([...ADMIN_AUDIT_ACTIONS].sort());
  });

  it('covers every config change this audit trail records', async () => {
    const { entity_type, action } = await checkLists();
    for (const t of [
      'pack',
      'card',
      'customer_group',
      'customer',
      'announcement',
    ]) {
      expect(entity_type).toContain(t);
    }
    for (const a of [
      'create',
      'edit',
      'delete',
      'edit_odds',
      'edit_members',
      'edit_top_hits',
      'reorder',
      'edit_odds_set',
      'set_player_group',
    ]) {
      expect(action).toContain(a);
    }
  });

  it('exports only the migration class (the loader instantiates the first export)', async () => {
    expect(Object.keys(migrationModule)).toEqual(['Migration20261006110000']);
  });
});

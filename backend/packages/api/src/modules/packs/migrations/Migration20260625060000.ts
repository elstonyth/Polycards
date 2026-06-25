import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// E1 — widen admin_action_audit inline CHECK constraints to add reward_pool
// entity_type and edit_reward_pool action values.
//
// The original CREATE TABLE (Migration20260623000000) used UNNAMED inline
// CHECK constraints; Postgres auto-names them as:
//   admin_action_audit_entity_type_check
//   admin_action_audit_action_check
// We drop and recreate each with the full superset (never narrowing).
export class Migration20260625060000 extends Migration {
  override async up(): Promise<void> {
    // Widen entity_type: add reward_pool
    this.addSql(
      `ALTER TABLE "admin_action_audit" DROP CONSTRAINT IF EXISTS "admin_action_audit_entity_type_check";`,
    );
    this.addSql(
      `ALTER TABLE "admin_action_audit" ADD CONSTRAINT "admin_action_audit_entity_type_check" CHECK ("entity_type" IN ('customer','commission','rewards_settings','credit','reward_pool'));`,
    );
    // Widen action: add edit_reward_pool
    this.addSql(
      `ALTER TABLE "admin_action_audit" DROP CONSTRAINT IF EXISTS "admin_action_audit_action_check";`,
    );
    this.addSql(
      `ALTER TABLE "admin_action_audit" ADD CONSTRAINT "admin_action_audit_action_check" CHECK ("action" IN ('freeze','unfreeze','reverse_commission','suspend_commission','unsuspend_commission','adjust_credit','edit_rewards_settings','edit_reward_pool'));`,
    );
  }

  override async down(): Promise<void> {
    // Refuse to narrow if ANY row uses a value being removed (same guard pattern
    // as 3a). A CHECK constraint validates ALL rows incl. soft-deleted, and BOTH
    // the entity_type ('reward_pool') and action ('edit_reward_pool') CHECKs are
    // narrowed here — so the guard must cover both columns and drop the
    // deleted_at filter.
    this.addSql(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM "admin_action_audit" WHERE entity_type = 'reward_pool' OR action = 'edit_reward_pool') THEN
        RAISE EXCEPTION 'refusing to narrow admin_action_audit: reward_pool/edit_reward_pool rows exist';
      END IF;
    END $$;`);
    this.addSql(
      `ALTER TABLE "admin_action_audit" DROP CONSTRAINT IF EXISTS "admin_action_audit_entity_type_check";`,
    );
    this.addSql(
      `ALTER TABLE "admin_action_audit" ADD CONSTRAINT "admin_action_audit_entity_type_check" CHECK ("entity_type" IN ('customer','commission','rewards_settings','credit'));`,
    );
    this.addSql(
      `ALTER TABLE "admin_action_audit" DROP CONSTRAINT IF EXISTS "admin_action_audit_action_check";`,
    );
    this.addSql(
      `ALTER TABLE "admin_action_audit" ADD CONSTRAINT "admin_action_audit_action_check" CHECK ("action" IN ('freeze','unfreeze','reverse_commission','suspend_commission','unsuspend_commission','adjust_credit','edit_rewards_settings'));`,
    );
  }
}

import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// site_settings.withdrawal_controls — the admin's withdrawal switches, daily
// schedules and Touch 'n Go floor (models/site-settings.ts,
// withdrawal-controls.ts). One nullable jsonb column on the singleton; NULL
// reads as "everything open", so old code and a fresh row behave as today.
// Edits audit as the existing site_settings / edit_site_settings pair, so the
// admin_action_audit CHECKs are untouched.
export class Migration20261017180000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`set local lock_timeout = '5s';`);
    this.addSql(
      `alter table if exists "site_settings" add column if not exists "withdrawal_controls" jsonb null;`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      `alter table if exists "site_settings" drop column if exists "withdrawal_controls";`,
    );
  }
}

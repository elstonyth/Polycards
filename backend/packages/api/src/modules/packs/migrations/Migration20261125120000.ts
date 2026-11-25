import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// Card.label_set / label_name / label_number: PSA's own wording for the slab
// label's top line, name line and card number. Nullable, blank by default: a
// blank field prints what the label derived before, so no card changes here.
export class Migration20261125120000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table if exists "card" add column if not exists "label_set" text null, add column if not exists "label_name" text null, add column if not exists "label_number" text null;`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      `alter table if exists "card" drop column if exists "label_set", drop column if exists "label_name", drop column if exists "label_number";`,
    );
  }
}

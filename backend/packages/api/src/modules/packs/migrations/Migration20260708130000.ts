import { Migration } from '@mikro-orm/migrations';

// Proof-of-delivery photos: a nullable jsonb array of /admin/media URLs on
// delivery_order, uploaded by the operator and shown to the customer.
export class Migration20260708130000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table if exists "delivery_order" add column if not exists "proof_images" jsonb null;`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      `alter table if exists "delivery_order" drop column if exists "proof_images";`,
    );
  }
}

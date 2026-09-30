import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// Gives every account a PERMANENT profile handle, so a rename stops breaking
// links (utils/profile-handle.ts has the model).
//
// Since Migration20260904120000 the display name (`first_name`) WAS the profile
// URL, and every rename retired a link that was already out in the world —
// production's /profile/Collector6167, posted to the public Telegram channel on
// 2026-09-29 for an Immortal pull, was a 404 by the next day. From here the URL
// is `metadata.handle`, which a rename never touches.
//
// Each live account's handle is frozen from the name it holds RIGHT NOW. That
// is the one choice that breaks nothing: every /profile/<name> link that
// resolves before this migration resolves to the same person after it, now
// permanently. The names are already legal URL segments and already unique
// case-insensitively (IDX_customer_first_name_lower_unique), so they are valid
// unique handles as they stand.
//
// `metadata.handle` is not new. Before 2026-09-04 it held a slug derived from
// the signup name (`wei-nguan-5ren`), dead since then — nothing reads it, and
// its links already 404. Every live value is overwritten, and a live row whose
// name is not usable gets the stale key REMOVED rather than inherited: it would
// otherwise become that player's permanent address, and it is built from a real
// name the player has since moved away from. Such rows are assigned a handle on
// their next GET /store/profiles/me.
//
// The blob is shared: it also holds the saved payout accounts, the referral
// code and the avatar. So the write is a jsonb merge (`||`) and a key removal
// (`- 'handle'`), never a replacement, and a row whose metadata is not a JSON
// object is left alone (an array `||` an object APPENDS instead of merging);
// the notice counts those so the deploy log shows if any exist.
export class Migration20260930120000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      do $$
      declare
        frozen int;
        cleared int;
        skipped int;
      begin
        update customer
          set metadata = coalesce(metadata, '{}'::jsonb)
                         || jsonb_build_object('handle', first_name)
          where deleted_at is null
            and first_name ~ '^[A-Za-z0-9_-]{3,30}$'
            and (metadata is null or jsonb_typeof(metadata) = 'object');
        get diagnostics frozen = row_count;

        update customer
          set metadata = metadata - 'handle'
          where deleted_at is null
            and not coalesce(first_name ~ '^[A-Za-z0-9_-]{3,30}$', false)
            and jsonb_typeof(metadata) = 'object'
            and metadata->'handle' is not null;
        get diagnostics cleared = row_count;

        select count(*) into skipped
          from customer
          where deleted_at is null
            and metadata is not null
            and jsonb_typeof(metadata) <> 'object';

        -- The only record of what this did: the overwritten slugs are gone
        -- afterwards (see down()).
        raise notice 'profile handle backfill: % frozen from the display name, % stale handles cleared, % skipped (metadata not an object)', frozen, cleared, skipped;
      end $$;
    `);

    // The invariant the lookup relies on: one handle, one live account, case
    // folded like the display-name index. Partial on deleted_at because account
    // deletion empties the blob anyway (utils/account-deletion.ts) — a deleted
    // account holds nothing. The expression must stay byte-for-byte what
    // findCustomerIdByHandle and claimHandle query, or PG cannot use it.
    this.addSql(`
      create unique index if not exists "IDX_customer_handle_lower_unique"
        on "customer" (lower(metadata->>'handle'))
        where "deleted_at" is null;
    `);
  }

  override async down(): Promise<void> {
    // Only the index comes back off. The backfill is not undone: the slugs it
    // overwrote are unrecoverable, and they were dead links anyway. Code rolled
    // back to the display-name model simply stops reading the key.
    this.addSql('drop index if exists "IDX_customer_handle_lower_unique";');
  }
}

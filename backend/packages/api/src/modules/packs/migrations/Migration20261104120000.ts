import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// Gives every account stuck with an 8-digit generated name or handle
// ("Collector63408743") a standard one, and keeps the old handle working as
// an alias so no link that is already out (Telegram posts, copied @handles)
// breaks.
//
// How those shapes were made (fixed in #985): a nameless signup is named
// "Collector" + 4 digits from its id, and on a collision the old suffix rule
// APPENDED 4 more digits instead of picking a new number. Prod on 2026-11-04:
//
//   A  1,869  name and handle both Collector########
//   B    139  name Collector####, handle Collector######## (the name was free,
//             but it was still another player's handle, so the two split)
//   C    201  renamed to a name of their own, handle Collector########
//   D     20  name Collector########, no handle yet (never opened a profile)
//
// The owner's rules (2026-11-04): each account gets a fresh "Collector" +
// 4 digits (5 or 6 only when the 4-digit tries are taken), the same for name
// and handle; a player who chose their own name (C) keeps it and only the
// handle changes; the old handle keeps resolving and the storefront redirects
// it to the new one.
//
// This is the one time a handle is moved (utils/profile-handle.ts says why
// handles are otherwise permanent). It is safe because the old handle stays
// reserved: `metadata.handle_alias` is unique like a handle, every allocator
// treats it as taken, and findCustomerIdByHandle resolves it.
//
// Before-state, for a manual revert: `handle_alias` is the old handle and
// `name_before_handle_backfill` the old display name, written wherever the
// name changes. down() does not restore them: the old 4-digit names (B) may
// have been taken by new signups since.
//
// Runs under the same advisory locks as claimUsername and claimHandle (same
// order: username, then handle), so a signup during the deploy cannot pick a
// number this run is handing out. The blob is merged (`||`), never replaced,
// and a row whose metadata is not a JSON object is left alone, as in
// Migration20260930140000. Re-running finds no rows, so a retried deploy is a
// no-op.
export class Migration20261104120000 extends Migration {
  override async up(): Promise<void> {
    // Same shape as IDX_customer_handle_lower_unique. The expression must stay
    // byte-for-byte what findCustomerIdByHandle and the claim probes query.
    this.addSql(`
      create unique index if not exists "IDX_customer_handle_alias_lower_unique"
        on "customer" (lower(metadata->>'handle_alias'))
        where "deleted_at" is null;
    `);

    this.addSql(`
      do $$
      declare
        r record;
        cand text;
        attempt int;
        width int;
        renamed_both int := 0;
        moved_handle int := 0;
        renamed_name int := 0;
      begin
        perform pg_advisory_xact_lock(hashtextextended('username:alloc', 0));
        perform pg_advisory_xact_lock(hashtextextended('profile_handle:alloc', 0));

        for r in
          select id, first_name, metadata->>'handle' as handle
            from customer
            where deleted_at is null
              and (metadata is null or jsonb_typeof(metadata) = 'object')
              and (metadata->>'handle' ~ '^Collector[0-9]{8}$'
                   or (first_name ~ '^Collector[0-9]{8}$'
                       and metadata->>'handle' is null))
            order by created_at, id
        loop
          -- The new suffix rule (utils/profile-handle.ts suffixedUsername):
          -- 8 tries at 4 digits, then 8 at 5, then 8 at 6. Free means free as
          -- a name, a handle and an alias, so name and handle can match.
          attempt := 0;
          loop
            width := 4 + attempt / 8;
            cand := 'Collector' || lpad(
              ((hashtextextended(r.id || '#' || attempt, 1104)
                & 9223372036854775807) % power(10, width)::bigint)::text,
              width, '0');
            exit when not exists (
              select 1 from customer c
                where c.deleted_at is null
                  and c.id <> r.id
                  and (lower(c.first_name) = lower(cand)
                       or lower(c.metadata->>'handle') = lower(cand)
                       or lower(c.metadata->>'handle_alias') = lower(cand)));
            attempt := attempt + 1;
            if attempt >= 24 then
              raise exception 'handle backfill: no free name for %', r.id;
            end if;
          end loop;

          if r.handle is null then
            -- D: only the name. The handle is frozen from it on first login.
            update customer
              set first_name = cand,
                  metadata = coalesce(metadata, '{}'::jsonb)
                    || jsonb_build_object('name_before_handle_backfill', r.first_name),
                  updated_at = now()
              where id = r.id;
            renamed_name := renamed_name + 1;
          elsif coalesce(r.first_name ~ '^Collector[0-9]{4,}$', false) then
            -- A and B: a generated name, so name and handle both move.
            update customer
              set first_name = cand,
                  metadata = metadata || jsonb_build_object(
                    'handle', cand,
                    'handle_alias', r.handle,
                    'name_before_handle_backfill', r.first_name),
                  updated_at = now()
              where id = r.id;
            renamed_both := renamed_both + 1;
          else
            -- C: the player chose this name. Only the handle moves.
            update customer
              set metadata = metadata || jsonb_build_object(
                    'handle', cand,
                    'handle_alias', r.handle),
                  updated_at = now()
              where id = r.id;
            moved_handle := moved_handle + 1;
          end if;
        end loop;

        raise notice 'handle backfill: % name and handle renamed, % handle only (own name kept), % name only (no handle yet)', renamed_both, moved_handle, renamed_name;
      end $$;
    `);
  }

  override async down(): Promise<void> {
    // Only the index comes off. The renames stay: see the header for why, and
    // for the metadata keys a manual revert would read.
    this.addSql(
      'drop index if exists "IDX_customer_handle_alias_lower_unique";',
    );
  }
}

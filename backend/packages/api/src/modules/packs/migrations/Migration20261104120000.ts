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
//   C    201  renamed to a name of their own, handle Collector######## (3
//             of them a Collector-shaped name the handle did not grow from)
//   D     20  name Collector########, no handle yet (never opened a profile)
//   E      1  name Collector####, no handle yet, and that name is already
//             someone else's handle (its first login would split the two)
//
// The owner's rules (2026-11-04): each account gets a fresh "Collector" +
// 4 digits (5 or 6 only when the 4-digit tries are taken), the same for name
// and handle; a player who chose their own name (C) keeps it and only the
// handle changes; the old handle keeps resolving and the storefront redirects
// it to the new one.
//
// This is the one time handles are moved (utils/profile-handle.ts says why
// they are otherwise permanent). It is safe because the old handle stays
// reserved as `metadata.handle_alias`: unique (Migration20261104110000),
// refused by claimUsername, claimHandle and the username guard, and resolved
// by findCustomerIdByHandle. That code shipped in the deploy BEFORE this one,
// so the pods still serving while this runs (pre-deploy migrate) already
// honour aliases.
//
// Before-state, for a manual revert: `handle_alias` is the old handle and
// `name_before_handle_backfill` the old display name, written wherever the
// name changes. down() does not restore them: the old 4-digit names (B, E)
// may have been taken by new signups since.
//
// Locking, in this order:
//  1. `username:alloc` then `profile_handle:alloc`, the allocators' own
//     advisory locks in their own order, so no signup can pick a number this
//     run is handing out.
//  2. ACCESS EXCLUSIVE on customer for the rest of the run (~0.2 s on a copy
//     of prod). The app's metadata writers read the whole blob and write it
//     back; one that read a row before this commits would write the old blob
//     over it afterwards, putting the 8-digit handle back and dropping the
//     alias. Only a lock that blocks their read prevents that; one advisory
//     lock per row would need ~2,229 entries in a lock table of 64 x 50.
//     lock_timeout bounds the wait for in-flight readers: past 5 s the
//     migration fails and the deploy rolls back, nothing half-done.
//
// The blob is merged (`||`), never replaced, and a row whose metadata is not
// a JSON object is left alone, as in Migration20260930140000. Re-running finds
// no rows, so a retried deploy is a no-op.
export class Migration20261104120000 extends Migration {
  override async up(): Promise<void> {
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
        perform set_config('lock_timeout', '5s', true);
        perform pg_advisory_xact_lock(hashtextextended('username:alloc', 0));
        perform pg_advisory_xact_lock(hashtextextended('profile_handle:alloc', 0));
        lock table customer in access exclusive mode;

        for r in
          select c.id, c.first_name, c.metadata->>'handle' as handle
            from customer c
            where c.deleted_at is null
              and (c.metadata is null or jsonb_typeof(c.metadata) = 'object')
              and (c.metadata->>'handle' ~ '^Collector[0-9]{8}$'
                   or (c.metadata->>'handle' is null
                       and (c.first_name ~ '^Collector[0-9]{8}$'
                            or (c.first_name ~ '^Collector[0-9]{4,}$'
                                and exists (
                                  select 1 from customer o
                                    where o.id <> c.id
                                      and o.deleted_at is null
                                      and (lower(o.metadata->>'handle') = lower(c.first_name)
                                           or lower(o.metadata->>'handle_alias') = lower(c.first_name)))))))
            order by c.created_at, c.id
        loop
          -- The new suffix rule's policy (utils/profile-handle.ts
          -- suffixedUsername): 8 tries at 4 digits, then 8 at 5, then 8 at 6.
          -- The numbers come from Postgres's own hash, not seedOf, so they are
          -- not the ones a signup would pick; only the width and collision
          -- policy is shared. Free means free as a name, a handle and an
          -- alias, so name and handle can match.
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
            -- D and E: only the name. The handle is frozen from it on first
            -- login, and the new name is free as a handle.
            update customer
              set first_name = cand,
                  metadata = coalesce(metadata, '{}'::jsonb)
                    || jsonb_build_object('name_before_handle_backfill', r.first_name),
                  updated_at = now()
              where id = r.id;
            renamed_name := renamed_name + 1;
          elsif coalesce(r.first_name ~ '^Collector[0-9]{4,}$', false)
                and left(lower(r.handle), length(r.first_name)) = lower(r.first_name) then
            -- A and B: a generated name, so name and handle both move. The
            -- shape alone is not proof (a player can type "Collector5555"):
            -- the handle must have grown from the name, as the old suffix
            -- rule made it. 3 prod rows have a Collector name unrelated to
            -- their handle; they keep it, like C.
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
    // Nothing to undo automatically: see the header for why the renames stay,
    // and for the metadata keys a manual revert would read. The alias index
    // belongs to Migration20261104110000.
  }
}

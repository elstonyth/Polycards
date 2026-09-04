import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// Makes the display name the profile URL, and makes that safe.
//
// `customer.first_name` is the storefront's "Display name" and is now also the
// public profile path (/profile/<display name>) — see utils/profile-handle.ts
// for why the derived-and-frozen `metadata.handle` had to go. Two things must
// be true before the app can rely on that:
//
//   1. every non-deleted customer has a name that is a legal URL segment
//      (ASCII A-Za-z0-9_- , 3..30), and
//   2. no two of them share one case-insensitively.
//
// Neither held. On 2026-09-04 production carried names with spaces, and one
// displaying "爱动漫的" — no ASCII at all; locally, 56 of 364 customers had no
// name whatsoever. So this backfills first and indexes second, in ONE
// migration: the index is the invariant the app leans on, and it cannot be
// added to a table that still violates it.
//
// The backfill mirrors sanitizeUsername/generatedUsername/suffixedUsername in
// utils/profile-handle.ts. It is deliberately NOT a shared implementation —
// this runs once against rows that predate the rule, while the TS functions run
// forever against rows that already follow it, and pinning the historical
// behaviour here keeps a later tweak to the live rules from silently rewriting
// what this migration is recorded as having done.
//
// Renames are chosen oldest-account-first, so the longest-standing holder of a
// contested name keeps it unsuffixed.
export class Migration20260904120000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      do $$
      declare
        r record;
        base text;
        cand text;
        n int;
      begin
        for r in
          select id, first_name from customer
          where deleted_at is null
          order by created_at asc, id asc
        loop
          -- Coerce to the username charset: runs of anything else collapse to
          -- '_', then trim the separators off both ends ("Wei Nguan" ->
          -- "Wei_Nguan"). Truncation to 30 happens before the final trim so a
          -- cut mid-run cannot leave a trailing '_'.
          base := regexp_replace(coalesce(r.first_name, ''), '[^A-Za-z0-9_-]+', '_', 'g');
          base := regexp_replace(base, '^[_-]+', '');
          base := regexp_replace(base, '[_-]+$', '');
          base := left(base, 30);
          base := regexp_replace(base, '[_-]+$', '');

          -- Nothing usable survived (empty, or wholly non-ASCII): give them an
          -- anonymous name shaped like every other one rather than a marker
          -- that announces itself as a fallback.
          if length(base) < 3 then
            base := 'Collector' || lpad((abs(hashtext(r.id)) % 10000)::text, 4, '0');
          end if;

          -- Probed against EVERY other live row, settled or not. Rows already
          -- processed hold their final name; rows still ahead hold their
          -- original one, which is exactly the name they will keep if it is
          -- already legal — so deferring to it here is correct, not merely
          -- cautious.
          cand := base;
          n := 0;
          while exists (
            select 1 from customer c
            where c.deleted_at is null
              and c.id <> r.id
              and lower(c.first_name) = lower(cand)
          ) loop
            n := n + 1;
            if n > 50 then
              -- Unreachable without 50 collisions on one stem; a customer id is
              -- unique by construction, so this always terminates the loop.
              cand := 'Collector' || left(regexp_replace(r.id, '[^A-Za-z0-9]', '', 'g'), 20);
              exit;
            end if;
            cand := left(base, 26);
            cand := regexp_replace(cand, '[_-]+$', '');
            if length(cand) = 0 then cand := 'Collector'; end if;
            cand := cand || lpad((abs(hashtext(r.id || '#' || n::text)) % 10000)::text, 4, '0');
          end loop;

          if cand is distinct from r.first_name then
            update customer set first_name = cand, updated_at = now() where id = r.id;
          end if;
        end loop;
      end $$;
    `);

    // The invariant itself. Partial on deleted_at so a soft-deleted account
    // does not hold its name hostage — a deleted user's URL is free to reuse,
    // and the lookup filters the same way. Case-folded because uniqueness that
    // ignored case would still let "MOONBREON" and "Moonbreon" exist side by
    // side, which is the duplicate-link problem this whole change exists to
    // prevent, not merely a cosmetic near-miss.
    this.addSql(`
      create unique index if not exists "IDX_customer_first_name_lower_unique"
        on "customer" (lower("first_name"))
        where "deleted_at" is null;
    `);
  }

  override async down(): Promise<void> {
    // Only the index comes back off. The renames are not restored: the
    // pre-migration names are unrecoverable from this side (the coercion is
    // lossy), and rolling back to a state where two customers claim one profile
    // URL would be worse than the rename it undoes.
    this.addSql(
      'drop index if exists "IDX_customer_first_name_lower_unique";',
    );
  }
}

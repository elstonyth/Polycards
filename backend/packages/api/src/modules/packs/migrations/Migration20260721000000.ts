import { Migration } from '@medusajs/framework/mikro-orm/migrations';

// Plan 057: challenge stage rewards become a PER-RANK table (ranks 1-10, each
// with an optional card and/or credits), replacing the fixed "cards -> ranks
// 1-3 / one credits value -> ranks 4-10" split.
//
// Backfill preserves the shipped intent exactly:
//   reward_card_ids[0..2] -> ranks 1..3 card_id
//   reward_credits        -> ranks 4..10 credits (EACH of those ranks gets the
//                            full value, matching how the shipped copy reads)
// Ranks with nothing to pay are omitted — rank_rewards is sparse by design.
export class Migration20260721000000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table if exists "challenge_stage" add column if not exists "rank_rewards" jsonb not null default '[]';`,
    );
    this.addSql(`update "challenge_stage" cs set "rank_rewards" = coalesce((
      select jsonb_agg(jsonb_build_object(
               'rank', r,
               'card_id', case when r <= 3 then cs."reward_card_ids"->>(r - 1) else null end,
               'credits', case when r >= 4 then cs."reward_credits" else 0 end
             ) order by r)
      from generate_series(1, 10) as r
      where (r <= 3 and jsonb_typeof(cs."reward_card_ids") = 'array'
             and cs."reward_card_ids"->>(r - 1) is not null)
         or (r >= 4 and cs."reward_credits" > 0)
    ), '[]'::jsonb);`);
    this.addSql(
      `alter table if exists "challenge_stage" drop column if exists "reward_credits";`,
    );
    this.addSql(
      `alter table if exists "challenge_stage" drop column if exists "raw_reward_credits";`,
    );
    this.addSql(
      `alter table if exists "challenge_stage" drop column if exists "reward_card_ids";`,
    );
  }

  // LOSSY by construction: ranks 4-10 collapse back to ONE credits value (the
  // largest configured) and only ranks 1-3 cards survive, in rank order.
  override async down(): Promise<void> {
    this.addSql(
      `alter table if exists "challenge_stage" add column if not exists "reward_credits" numeric not null default 0;`,
    );
    this.addSql(
      `alter table if exists "challenge_stage" add column if not exists "raw_reward_credits" jsonb not null default '{"value":"0","precision":20}';`,
    );
    this.addSql(
      `alter table if exists "challenge_stage" add column if not exists "reward_card_ids" jsonb not null default '[]';`,
    );
    this.addSql(`update "challenge_stage" cs set
      "reward_credits" = coalesce((
        select max((e->>'credits')::numeric)
        from jsonb_array_elements(cs."rank_rewards") e
        where (e->>'rank')::int >= 4
      ), 0),
      "reward_card_ids" = coalesce((
        select jsonb_agg(e->'card_id' order by (e->>'rank')::int)
        from jsonb_array_elements(cs."rank_rewards") e
        where (e->>'rank')::int <= 3 and e->>'card_id' is not null
      ), '[]'::jsonb);`);
    this.addSql(
      `update "challenge_stage" set "raw_reward_credits" = jsonb_build_object('value', "reward_credits"::text, 'precision', 20);`,
    );
    this.addSql(
      `alter table if exists "challenge_stage" drop column if exists "rank_rewards";`,
    );
  }
}

import { model } from "@medusajs/framework/utils";

// Pull — the ledger: one row per opened pack (the rolled result). Written by the
// open-pack workflow; it is the source of truth for the live-pulls feed, the
// leaderboard, AND the customer's vault (a vault item = a pull with status
// "vaulted" — no separate vault table).
//
// References use the same stable business keys as PackOdds (Pack.slug,
// Card.handle). `order_id` ties the pull to the Medusa order that paid for it
// (nullable until checkout is wired).
export const Pull = model
  .define("pull", {
    id: model.id().primaryKey(),
    customer_id: model.text(),
    pack_id: model.text(), // = Pack.slug
    card_id: model.text(), // = Card.handle (the won card)
    order_id: model.text().nullable(),
    rolled_at: model.dateTime(),
    // TRUE only when this pull actually decremented physical stock (pulls at 0
    // stock / untracked products don't). Buyback restores +1 ONLY when set —
    // otherwise repeated 0-stock pull→sell cycles would mint phantom units.
    stock_earmarked: model.boolean().default(false),
    // Vault lifecycle: every pull starts vaulted; instant buyback (at reveal or
    // later from the vault page) flips it to bought_back and credits the customer.
    status: model.enum(["vaulted", "bought_back"]).default("vaulted"),
    // USD actually credited (decimal, never cents) — a SNAPSHOT taken at buyback
    // time (current FMV × the pack's buyback_percent), kept since FMV moves.
    buyback_amount: model.bigNumber().nullable(),
    buyback_at: model.dateTime().nullable(),
  })
  .indexes([
    // vault + public profile + admin gacha: filter customer_id, order rolled_at.
    {
      name: "IDX_pull_customer_id_rolled_at",
      on: ["customer_id", "rolled_at"],
      where: "deleted_at IS NULL",
    },
    // global recent-pulls feed + leaderboard window: order/range on rolled_at,
    // no customer predicate (so it can't use the composite above).
    {
      name: "IDX_pull_rolled_at",
      on: ["rolled_at"],
      where: "deleted_at IS NULL",
    },
  ]);

export default Pull;

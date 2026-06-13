import { ExecArgs } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import { deleteProductsWorkflow } from "@medusajs/medusa/core-flows";
import PacksModuleService from "../modules/packs/service";
import { PACKS_MODULE } from "../modules/packs";

// ---------------------------------------------------------------------------
// One-off catalog cleanup: the business now sells Pokémon only, so this purges
// every non-Pokémon gacha entity from the live DB. The Pokémon-only allow-list
// below MUST stay in sync with the surviving CARD_PRODUCTS / PACK_SEED in
// seed.ts (this script is the "delete" half of the wipe-and-reseed; seed.ts is
// idempotent/additive and never deletes, so the removal has to be explicit).
//
// Deleted (FK-safe order): Pulls → PackOdds → Packs → Cards → card Products.
// PRESERVED on purpose: customers, the CreditTransaction ledger (site credit),
// and every Pokémon pull/vault entry. Re-run safe — already-clean rows no-op.
// ---------------------------------------------------------------------------

const POKEMON_PACK_SLUGS = new Set([
  "pokemon-mythic",
  "pokemon-legend",
  "pokemon-elite",
  "pokemon-platinum",
  "pokemon-rookie",
  "pokemon-black",
  "pokemon-diamond",
  "pokemon-trainer",
]);

const POKEMON_CARD_HANDLES = new Set([
  "celebi",
  "mewtwo",
  "darkrai-gg",
  "jolteon",
  "shaymin",
  "rapidash",
  "hooh",
  "gengar",
  "espathra",
  "mimikyu",
  "lycanroc",
  "garchomp",
  "ribombee",
  "obstagoon",
  "darkrai-tot",
  "dustox",
]);

// Comfortably above the full catalog size so a single list() reads everything
// (a framework page cap would otherwise leave stale rows behind).
const TAKE = 100_000;

export default async function removeNonPokemon({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const packs: PacksModuleService = container.resolve(PACKS_MODULE);
  const productModule = container.resolve(Modules.PRODUCT);

  logger.info("Removing non-Pokémon catalog entities...");

  // Pulls — drop any whose pack OR card is non-Pokémon, so the vault/leaderboard
  // never joins a now-deleted card/pack (a dangling card_id breaks the UI).
  const allPulls = await packs.listPulls(
    {},
    { select: ["id", "pack_id", "card_id"], take: TAKE },
  );
  const stalePulls = allPulls.filter(
    (p) =>
      !POKEMON_PACK_SLUGS.has(p.pack_id) ||
      !POKEMON_CARD_HANDLES.has(p.card_id),
  );
  if (stalePulls.length) {
    await packs.deletePulls(stalePulls.map((p) => p.id));
  }
  logger.info(`Deleted ${stalePulls.length} non-Pokémon pull(s).`);

  // PackOdds — every weight row for a non-Pokémon pack.
  const allOdds = await packs.listPackOdds(
    {},
    { select: ["id", "pack_id"], take: TAKE },
  );
  const staleOdds = allOdds.filter((o) => !POKEMON_PACK_SLUGS.has(o.pack_id));
  if (staleOdds.length) {
    await packs.deletePackOdds(staleOdds.map((o) => o.id));
  }
  logger.info(`Deleted ${staleOdds.length} non-Pokémon odds row(s).`);

  // Packs.
  const allPacks = await packs.listPacks(
    {},
    { select: ["id", "slug"], take: TAKE },
  );
  const stalePacks = allPacks.filter((p) => !POKEMON_PACK_SLUGS.has(p.slug));
  if (stalePacks.length) {
    await packs.deletePacks(stalePacks.map((p) => p.id));
  }
  logger.info(`Deleted ${stalePacks.length} non-Pokémon pack(s).`);

  // Cards (gacha prize metadata).
  const allCards = await packs.listCards(
    {},
    { select: ["id", "handle"], take: TAKE },
  );
  const staleCards = allCards.filter(
    (c) => !POKEMON_CARD_HANDLES.has(c.handle),
  );
  if (staleCards.length) {
    await packs.deleteCards(staleCards.map((c) => c.id));
  }
  logger.info(`Deleted ${staleCards.length} non-Pokémon card(s).`);

  // Card Products (the Medusa Product mirror, handle === Card.handle).
  const staleHandles = staleCards.map((c) => c.handle);
  if (staleHandles.length) {
    const staleProducts = await productModule.listProducts({
      handle: staleHandles,
    });
    if (staleProducts.length) {
      await deleteProductsWorkflow(container).run({
        input: { ids: staleProducts.map((p) => p.id) },
      });
    }
    logger.info(`Deleted ${staleProducts.length} non-Pokémon product(s).`);
  }

  logger.info("Non-Pokémon catalog removal complete.");
}

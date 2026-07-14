import { ExecArgs } from '@medusajs/framework/types';
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils';
import { deleteProductsWorkflow } from '@medusajs/medusa/core-flows';
import PacksModuleService from '../modules/packs/service';
import { PACKS_MODULE } from '../modules/packs';

// ---------------------------------------------------------------------------
// Catalog cutover to the Polycards brand (2026-07): wipe the ENTIRE seeded
// gacha catalog and its play-state, then install the 5 Polycards tier packs.
// Companion to remove-non-pokemon.ts (same FK-safe order), but a full reset:
//
// Deleted: DeliveryOrderItems + DeliveryOrders (they join pulls being wiped),
// Pulls, PackOdds, ALL Packs (incl. reward_box pool rows and the pikachu test
// pack), Cards, CardPriceHistory, and the card Products (handle === Card.handle).
//
// PRESERVED: customers, the CreditTransaction ledger (site credit — rows may
// carry a dangling card_id for display; readers are null-safe), VIP state,
// reward boxes (product-kind prizes referencing deleted handles are LOGGED so
// the operator can retune them), and the PixelPokemon library.
//
// Created: the 5 Polycards packs (Bronze → Diamond) as DRAFTS — a pack with an
// empty prize pool must not be active (every spin would fail). Assign cards in
// admin, then activate. Asset paths are storefront-relative
// (public/images/polycards/), shipped in the same commit as this script.
//
// ONE-SHOT: if any Polycards pack already exists the script exits without
// touching ANYTHING — a re-run after the operator has populated/activated the
// new packs must not wipe their odds/pulls/state. Delete the polycards packs
// manually first if you truly want to re-run the cutover.
// Run: corepack yarn medusa exec ./src/scripts/replace-catalog-polycards.ts
// ---------------------------------------------------------------------------

const POLYCARDS_PACKS = [
  { slug: 'bronze-pack', title: 'Bronze Pack', price: 50, rank: 0 },
  { slug: 'silver-pack', title: 'Silver Pack', price: 250, rank: 1 },
  { slug: 'gold-pack', title: 'Gold Pack', price: 1000, rank: 2 },
  { slug: 'platinum-pack', title: 'Platinum Pack', price: 2500, rank: 3 },
  { slug: 'diamond-pack', title: 'Diamond Pack', price: 5000, rank: 4 },
].map((p) => ({
  ...p,
  category: 'pokemon',
  image: `/images/polycards/${p.slug}.webp`,
  display_image: `/images/polycards/${p.slug.replace('-pack', '')}-factory.webp`,
  buyback_percent: 90,
  boost: false,
  status: 'draft' as const,
}));

// Comfortably above the full catalog size so a single list() reads everything.
const TAKE = 100_000;

export default async function replaceCatalogPolycards({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const packs: PacksModuleService = container.resolve(PACKS_MODULE);
  const productModule = container.resolve(Modules.PRODUCT);

  // One-shot guard: a prior run means the new catalog (and possibly operator
  // work on it — cards, odds, active status) is live. Never wipe that.
  const alreadyCutOver = await packs.listPacks(
    { slug: POLYCARDS_PACKS.map((p) => p.slug) },
    { select: ['slug'], take: POLYCARDS_PACKS.length },
  );
  if (alreadyCutOver.length > 0) {
    logger.info(
      `Polycards cutover already ran (${alreadyCutOver.map((p) => p.slug).join(', ')} present) — nothing to do.`,
    );
    return;
  }

  logger.info('Polycards catalog cutover: wiping old gacha catalog...');

  // Delivery orders + items — they join Pulls (all being wiped below), and
  // items carry no snapshot, so keeping them would render broken rows.
  const items = await packs.listDeliveryOrderItems(
    {},
    { select: ['id'], take: TAKE },
  );
  if (items.length)
    await packs.deleteDeliveryOrderItems(items.map((i) => i.id));
  const orders = await packs.listDeliveryOrders(
    {},
    { select: ['id'], take: TAKE },
  );
  if (orders.length) await packs.deleteDeliveryOrders(orders.map((o) => o.id));
  logger.info(
    `Deleted ${orders.length} delivery order(s) / ${items.length} item(s).`,
  );

  // Pulls — every pull references a wiped card/pack; a dangling card_id breaks
  // the vault/leaderboard joins.
  const pulls = await packs.listPulls({}, { select: ['id'], take: TAKE });
  if (pulls.length) await packs.deletePulls(pulls.map((p) => p.id));
  logger.info(`Deleted ${pulls.length} pull(s).`);

  // PackOdds — the weight tables of the wiped packs.
  const odds = await packs.listPackOdds({}, { select: ['id'], take: TAKE });
  if (odds.length) await packs.deletePackOdds(odds.map((o) => o.id));
  logger.info(`Deleted ${odds.length} odds row(s).`);

  // Packs — ALL of them (seeded catalog, reward_box pool rows, test packs).
  const oldPacks = await packs.listPacks(
    {},
    { select: ['id', 'slug'], take: TAKE },
  );
  if (oldPacks.length) await packs.deletePacks(oldPacks.map((p) => p.id));
  logger.info(
    `Deleted ${oldPacks.length} pack(s): ${oldPacks.map((p) => p.slug).join(', ') || '(none)'}`,
  );

  // Cards + price history, remembering handles for the product mirror below.
  const cards = await packs.listCards(
    {},
    { select: ['id', 'handle'], take: TAKE },
  );
  const cardHandles = cards.map((c) => c.handle);
  if (cards.length) await packs.deleteCards(cards.map((c) => c.id));
  const history = await packs.listCardPriceHistories(
    {},
    { select: ['id'], take: TAKE },
  );
  if (history.length)
    await packs.deleteCardPriceHistories(history.map((h) => h.id));
  logger.info(
    `Deleted ${cards.length} card(s), ${history.length} price-history row(s).`,
  );

  // Card Products — the Medusa Product mirror (handle === Card.handle).
  if (cardHandles.length) {
    const products = await productModule.listProducts(
      { handle: cardHandles },
      { take: TAKE },
    );
    if (products.length) {
      await deleteProductsWorkflow(container).run({
        input: { ids: products.map((p) => p.id) },
      });
    }
    logger.info(`Deleted ${products.length} card product(s).`);
  }

  // Reward boxes are PRESERVED — but a product-kind prize whose handle just
  // got wiped can no longer grant; surface them for the operator to retune.
  const prizes = await packs.listRewardBoxPrizes({}, { take: TAKE });
  const handleSet = new Set(cardHandles);
  const dangling = prizes.filter(
    (p) =>
      p.kind === 'product' &&
      handleSet.has(
        (p.payload as { product_handle?: string })?.product_handle ?? '',
      ),
  );
  if (dangling.length) {
    logger.warn(
      `${dangling.length} reward-box product prize(s) reference deleted cards — retune them in admin: ` +
        dangling.map((p) => p.id).join(', '),
    );
  }

  // Install the Polycards tier ladder (draft — assign cards, then activate).
  const existing = await packs.listPacks(
    { slug: POLYCARDS_PACKS.map((p) => p.slug) },
    { select: ['slug'], take: POLYCARDS_PACKS.length },
  );
  const have = new Set(existing.map((p) => p.slug));
  const toCreate = POLYCARDS_PACKS.filter((p) => !have.has(p.slug));
  if (toCreate.length) await packs.createPacks(toCreate);
  logger.info(
    `Created ${toCreate.length} Polycards pack(s): ${toCreate.map((p) => p.slug).join(', ')}`,
  );

  logger.info(
    'Polycards cutover complete. Packs are DRAFTS with empty pools — ' +
      'register cards in admin, assign them to packs, then set status active.',
  );
}

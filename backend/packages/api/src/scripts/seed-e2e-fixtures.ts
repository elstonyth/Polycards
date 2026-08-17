import { ExecArgs } from '@medusajs/framework/types';
import {
  ContainerRegistrationKeys,
  Modules,
  ProductStatus,
} from '@medusajs/framework/utils';
import { createProductsWorkflow } from '@medusajs/medusa/core-flows';
import { RARITY_WEIGHT, type OddsRarity } from '@acme/odds-math';
import { PACKS_MODULE } from '../modules/packs';
import type PacksModuleService from '../modules/packs/service';
import { DEFAULT_MARKET_MULTIPLIER } from '../modules/packs/pricing';
import {
  buildCardProductInput,
  resolveCardProductContext,
} from '../modules/packs/card-product';
import {
  PROD_CARDS,
  PROD_PACKS,
  PROD_CATALOG_CAPTURED_AT,
  PROD_CATALOG_SOURCE,
} from './prod-catalog.data';

// seed-e2e-fixtures — installs a LOCAL MIRROR OF THE PRODUCTION CATALOG so the
// E2E suite exercises the real storefront: the real pack slugs (bronze-pack …
// diamond-pack), the real prices, and real cards with real names, art, tiers and
// prices — instead of the invented 'pokemon-rookie' / 'PW Pikachu' fixture the
// suite used to run on. That fixture made every spec a test of a catalog that
// existed nowhere, so catalog-shaped bugs were structurally untestable.
//
// The catalog data is a committed snapshot of the live site — see
// ./prod-catalog.data.ts, refreshed with `node scripts/snapshot-prod-catalog.mjs`
// from the repo root (read-only; it only GETs public storefront pages).
//
// Why a fixture at all: the prod catalog seed (seed.ts, run by deploy:init)
// ships packs as EMPTY DRAFTS by design (operators register cards in admin), so
// a fresh CI DB has NO openable pack — the nightly E2E suite then dies at
// auth.setup's `seed packs present` preflight and 19 specs never run. This
// script fills those same packs in with the pool prod has, plus the few
// non-catalog rows the specs need (firm FX, an eligible product, a voucher
// grant).
//
// NEVER wire this into deploy:init. It now writes to the REAL pack slugs, so
// against a production (or prod-cloned) database it would rewrite the operator's
// live catalog. The localhost guard below is what enforces that — it is load
// bearing, not decoration.
//
// Idempotent: guarded by pack slug, card handle, and (pack_id, card_id) so a
// re-run is a no-op. Run from backend/packages/api:
//   corepack yarn medusa exec ./src/scripts/seed-e2e-fixtures.ts

// The FX rate the fixture installs when the DB has none. When a rate IS already
// present (a dev DB the scheduled frankfurter job has filled), that one is used
// as the divisor instead — the point is that a seeded card renders the same RM
// figure production shows, and that only holds if the conversion runs at the
// rate this database actually prices with.
const FIXTURE_FX_USD_MYR = 4.0725;

// The free welcome pack (spec 2026-08-14) is hidden from GET /store/packs, so
// the public snapshot cannot see prod's copy. Recreate it from real snapshot
// cards: reserved category, price 0, and a small pool of the CHEAPEST cards —
// the one free open should land a modest card, not the RM187k chase.
const FREE_PACK_SLUG = 'free-welcome';
const FREE_PACK_CARDS = 3;

/** Cards store raw USD FMV; the storefront shows usd × fx × multiplier. */
const usdFromDisplayMyr = (myr: number, fxRate: number): number =>
  Number((myr / (fxRate * DEFAULT_MARKET_MULTIPLIER)).toFixed(4));

/** Refuse to run against anything but a local database.
 *
 *  An allowlist, not a denylist: this script rewrites the REAL catalog rows, and
 *  "does this host look like prod?" fails open on every host nobody thought of.
 *  CI runs against a localhost service container, and so does every dev stack. */
function assertLocalDatabase(): void {
  const url = process.env.DATABASE_URL ?? '';
  // URL, not a hand-rolled regex: a credential-less `postgres://localhost/medusa`
  // fooled the regex into reading a single stray character as the host. It failed
  // closed, but refusing a legitimately local URL is how a guard gets deleted.
  // `::1` arrives bracketed from URL.hostname.
  let host = '';
  try {
    host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  } catch {
    host = '';
  }
  const local = [
    'localhost',
    '127.0.0.1',
    '::1',
    'postgres',
    'host.docker.internal',
  ];
  const why = !host
    ? "DATABASE_URL is unset or unparseable — can't prove the target is local"
    : !local.includes(host)
      ? `DATABASE_URL host '${host}' is not local`
      : // Second, independent condition. `medusa build` compiles this script into
        // the production bundle, so the guard is reachable from a prod shell —
        // and a hostname check alone is satisfied by an SSH tunnel or a
        // port-forward, which make a remote database look like 127.0.0.1.
        /^prod/i.test(process.env.NODE_ENV ?? '')
        ? `NODE_ENV is '${process.env.NODE_ENV}'`
        : '';
  if (!why) return;
  throw new Error(
    `[e2e] REFUSING to seed: ${why}. This fixture writes to the REAL pack slugs ` +
      '(bronze-pack…diamond-pack) and would overwrite a live catalog. Point ' +
      'DATABASE_URL at a local/throwaway DB and run outside NODE_ENV=production.',
  );
}

export default async function seedE2eFixtures({
  container,
}: ExecArgs): Promise<void> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const packs = container.resolve<PacksModuleService>(PACKS_MODULE);

  assertLocalDatabase();
  logger.info(
    `[e2e] Installing the prod catalog mirror (${PROD_PACKS.length} packs, ` +
      `${PROD_CARDS.length} cards) captured from ${PROD_CATALOG_SOURCE} on ` +
      `${PROD_CATALOG_CAPTURED_AT}.`,
  );

  // --- FX rate (firm) ------------------------------------------------------
  // Seeded FIRST: it is the divisor the card FMVs below are derived with, and
  // buyback quotes are FIRM only when a USD_MYR FxRate row exists (else
  // resolveFxRateInfo returns firm:false and the reveal shows "Keep in vault"
  // with NO sell button, and the vault bulk-sell button is disabled). The base
  // seed creates none — locally a scheduled frankfurter fetch fills it, but a
  // fresh CI DB has nothing, so every sell-path spec fails without this.
  const [fx] = await packs.listFxRates({ pair: 'USD_MYR' }, { take: 1 });
  let fxRate = FIXTURE_FX_USD_MYR;
  if (!fx) {
    await packs.createFxRates([
      {
        pair: 'USD_MYR',
        rate: FIXTURE_FX_USD_MYR,
        source: 'e2e-fixture',
        manual_override: false,
        manual_rate: null,
      },
    ]);
    logger.info(`[e2e] Seeded firm USD_MYR FX rate (${FIXTURE_FX_USD_MYR}).`);
  } else {
    // A manual override is what the pricing module actually converts with, so
    // it is what the FMV derivation below has to use too.
    fxRate = Number(
      (fx.manual_override ? (fx.manual_rate ?? fx.rate) : fx.rate) ??
        FIXTURE_FX_USD_MYR,
    );
    logger.info(`[e2e] FX rate already present (${fxRate}), reusing it.`);
  }

  // --- Cards (real prod cards) ---------------------------------------------
  const cardHandles = PROD_CARDS.map((c) => c.handle);
  const existingCards = await packs.listCards(
    { handle: cardHandles },
    { select: ['id', 'handle'], take: cardHandles.length },
  );
  const cardIdByHandle = new Map(existingCards.map((c) => [c.handle, c.id]));
  const cardFields = (c: (typeof PROD_CARDS)[number]) => ({
    name: c.name,
    set: c.set,
    grader: c.grader,
    grade: c.grade,
    market_value: usdFromDisplayMyr(c.display_myr, fxRate),
    // The divisor above assumes the default multiplier, so write it too: a
    // pre-existing card carrying a custom multiplier would otherwise render at
    // usd x fx x <custom>, i.e. NOT the production figure this mirror exists to
    // reproduce (the store route reads market_multiplier at request time).
    market_multiplier: DEFAULT_MARKET_MULTIPLIER,
    image: c.image,
    // Prod's baked slab composite (a public CDN URL) — reused as-is so the
    // slab rendering path is exercised without running the bake, which would
    // hit the localhost-SSRF guard in CI.
    slab_image: c.slab_image,
    // The key is the handle of the file a re-bake would DELETE. It belongs to
    // the composite we just replaced, so leaving it would point a local re-bake
    // at the wrong file.
    slab_image_key: null,
    pokemon_dex: c.pokemon_dex,
    sprite_image: c.sprite_image,
    // Gacha-pool only: this fixture creates no backing Medusa product, and
    // for_sale defaults true (which assumes a mirrored product exists).
    for_sale: false,
  });
  const cardsToCreate = PROD_CARDS.filter(
    (c) => !cardIdByHandle.has(c.handle),
  ).map((c) => ({ handle: c.handle, ...cardFields(c) }));
  // Sync, not skip: prices move, art gets re-baked, and the FX divisor above can
  // change between runs. A mirrored card that never updates drifts away from the
  // production figure it exists to reproduce.
  const cardsToSync = PROD_CARDS.filter((c) =>
    cardIdByHandle.has(c.handle),
  ).map((c) => ({ id: cardIdByHandle.get(c.handle)!, ...cardFields(c) }));
  if (cardsToSync.length > 0) {
    await packs.updateCards(cardsToSync);
    logger.info(`[e2e] Synced ${cardsToSync.length} card(s) to the snapshot.`);
  }
  if (cardsToCreate.length > 0) {
    await packs.createCards(cardsToCreate);
    logger.info(`[e2e] Seeded ${cardsToCreate.length} prod card(s).`);
  }

  // --- Packs (the real 5, active) ------------------------------------------
  // create-or-SYNC, not create-or-skip. The base seed ships these slugs as
  // DRAFTS (a draft pack 404s on GET /store/packs/:slug and cannot be opened),
  // and a long-lived dev DB drifts further still — the local rows carried
  // bronze RM50 / silver RM250 while production charges RM300 / RM600. Tests
  // written against those prices prove nothing about the live economy, so every
  // mirrored field is written on each run.
  const freePack = {
    slug: FREE_PACK_SLUG,
    title: 'Free Welcome Pack',
    price: 0,
    buyback_percent: 90,
    image: '/images/polycards/free-pack-badge.webp',
    display_image: null as string | null,
    rank: PROD_PACKS.length,
    category: 'free_welcome',
    cards: [...PROD_CARDS]
      .sort((a, b) => a.display_myr - b.display_myr)
      .slice(0, FREE_PACK_CARDS)
      .map((c) => ({ handle: c.handle, rarity: 'Common' })),
  };
  const allPacks = [
    ...PROD_PACKS.map((p) => ({ ...p, category: 'pokemon' })),
    freePack,
  ];

  const packSlugs = allPacks.map((p) => p.slug);
  const mirrored = new Set(packSlugs);
  const existingPacks = await packs.listPacks(
    { slug: packSlugs },
    { select: ['id', 'slug', 'status'], take: packSlugs.length },
  );
  const bySlug = new Map(existingPacks.map((p) => [p.slug, p]));

  const fields = (p: (typeof allPacks)[number]) => ({
    title: p.title,
    category: p.category, // must be non-'reward_box' to be openable
    price: p.price,
    image: p.image,
    display_image: p.display_image,
    buyback_percent: p.buyback_percent,
    rank: p.rank,
    status: 'active' as const,
    // helpers/catalog.ts filters on in_stock, so an out-of-stock flag left over
    // on a dev DB would silently promote the NEXT pack to "the one the specs
    // open" and double every funding amount in the suite.
    in_stock: true,
  });

  const packsToCreate = allPacks
    .filter((p) => !bySlug.has(p.slug))
    .map((p) => ({ slug: p.slug, ...fields(p) }));
  if (packsToCreate.length > 0) {
    await packs.createPacks(packsToCreate);
    logger.info(`[e2e] Seeded ${packsToCreate.length} pack(s).`);
  }

  const packsToSync = allPacks
    .filter((p) => bySlug.has(p.slug))
    .map((p) => ({ id: bySlug.get(p.slug)!.id, ...fields(p) }));
  if (packsToSync.length > 0) {
    await packs.updatePacks(packsToSync);
    logger.info(
      `[e2e] Synced ${packsToSync.length} existing pack(s) to the prod mirror ` +
        '(price/title/art/buyback/status).',
    );
  }

  // Retire anything else that is ACTIVE and openable. Without this the legacy
  // fixture packs ('pokemon-rookie' at RM25, 'pokemon-elite') keep sitting in
  // the catalog — and since the specs now pick the CHEAPEST openable pack, they
  // would still land on the invented packs this change exists to remove.
  // Deactivated, never deleted: Pull rows reference these slugs, and a local
  // catalog that silently loses history is worse than one carrying drafts.
  // reward_box / free_welcome are skipped — they are hidden surfaces the daily
  // box and the welcome badge own, not part of the openable catalog.
  const STRAY_SCAN = 500;
  const activePacks = await packs.listPacks(
    { status: 'active' },
    { select: ['id', 'slug', 'category'], take: STRAY_SCAN },
  );
  if (activePacks.length === STRAY_SCAN) {
    // Say so rather than letting a truncated page read as "swept everything".
    logger.warn(
      `[e2e] Stray scan hit its ${STRAY_SCAN}-row cap — some active packs were ` +
        'not examined. Re-run, or raise STRAY_SCAN.',
    );
  }
  const strays = activePacks.filter(
    (p) =>
      !mirrored.has(p.slug) &&
      p.category !== 'reward_box' &&
      p.category !== 'free_welcome',
  );
  if (strays.length > 0) {
    await packs.updatePacks(
      strays.map((p) => ({ id: p.id, status: 'draft' as const })),
    );
    logger.info(
      `[e2e] Retired ${strays.length} off-catalog pack(s) to draft: ` +
        `${strays.map((p) => p.slug).join(', ')}.`,
    );
  }

  // --- Odds (one weighted row per pack×card) -------------------------------
  // Pull chance = weight / Σ(weights in pack). RARITY_WEIGHT is the same table
  // the live odds engine uses, and the rarity is the card's tier IN THAT PACK as
  // production has it — so the fixture's rarity mix matches the real pack.
  // Idempotency is keyed per (pack, card), not per pack: a partial failure that
  // created only some of a pack's odds rows must be backfilled on re-run, not
  // skipped because the pack already has *an* odds row.
  const ODDS_SCAN = 5000;
  const existingOdds = await packs.listPackOdds(
    { pack_id: packSlugs },
    // No cap tied to the mirror's size: the point of the read is to find rows
    // that AREN'T in the mirror, and a take of exactly the mirror size would
    // hide the extras it needs to see.
    { select: ['id', 'pack_id', 'card_id'], take: ODDS_SCAN },
  );
  if (existingOdds.length === ODDS_SCAN) {
    // A truncated read under-prunes AND then collides on the (pack, card)
    // unique index when the create runs. Say so instead of failing cryptically.
    logger.warn(
      `[e2e] Odds scan hit its ${ODDS_SCAN}-row cap — the pool sync is ` +
        'incomplete. Raise ODDS_SCAN.',
    );
  }
  const oddsKey = (packId: string, cardId: string): string =>
    `${packId}::${cardId}`;
  const oddsIdByKey = new Map(
    existingOdds
      .filter((o) => o.card_id != null)
      .map((o) => [oddsKey(o.pack_id, o.card_id as string), o.id]),
  );
  // The snapshot types rarity as a plain string (it is scraped); narrow it here
  // so an unknown tier degrades to Common instead of writing a row the odds
  // engine can't weight.
  const oddsFields = (rawRarity: string) => {
    const rarity: OddsRarity =
      rawRarity in RARITY_WEIGHT ? (rawRarity as OddsRarity) : 'Common';
    return {
      rarity,
      weight: RARITY_WEIGHT[rarity],
      // The reset half of the sync. odds-reflection.spec locks a card at 100%
      // and restores in a `finally` — but a crash, a Ctrl-C or a failing
      // restore leaves the pack rigged, and if a re-seed did not clear this the
      // rigged state would survive every later run with nothing pointing at the
      // cause. weight_2/3 are NULL = "inherit the previous set".
      locked: false,
      weight_2: null,
      weight_3: null,
    };
  };
  const oddsToCreate = allPacks.flatMap((pack) =>
    pack.cards
      .filter((c) => !oddsIdByKey.has(oddsKey(pack.slug, c.handle)))
      .map((c) => ({
        pack_id: pack.slug,
        card_id: c.handle,
        ...oddsFields(c.rarity),
      })),
  );
  // Sync the rows that already exist — without this the pool is only ever
  // added to, so a tier that moved in prod (or a win rate a spec left behind)
  // is never corrected and the "mirror" quietly stops being one.
  const oddsToSync = allPacks.flatMap((pack) =>
    pack.cards
      .filter((c) => oddsIdByKey.has(oddsKey(pack.slug, c.handle)))
      .map((c) => ({
        id: oddsIdByKey.get(oddsKey(pack.slug, c.handle))!,
        ...oddsFields(c.rarity),
      })),
  );
  if (oddsToSync.length > 0) {
    await packs.updatePackOdds(oddsToSync);
    logger.info(
      `[e2e] Reset ${oddsToSync.length} existing pool row(s) to the mirror's ` +
        'tiers and weights (clears any win-rate a spec left behind).',
    );
  }
  // Prune what prod does not have. A mirrored pack whose pool still carries the
  // old local fixture cards is not a mirror — the extra cards change every
  // pull's odds, the rarity mix and the buyback expectation. Only pool rows are
  // dropped; the Card rows and any Pull history survive.
  const wanted = new Set(
    allPacks.flatMap((p) => p.cards.map((c) => oddsKey(p.slug, c.handle))),
  );
  const oddsToDrop = existingOdds.filter(
    (o) => o.card_id != null && !wanted.has(oddsKey(o.pack_id, o.card_id)),
  );
  if (oddsToDrop.length > 0) {
    await packs.deletePackOdds(oddsToDrop.map((o) => o.id));
    logger.info(
      `[e2e] Pruned ${oddsToDrop.length} off-mirror pool row(s) from the ` +
        'mirrored packs.',
    );
  }
  if (oddsToCreate.length > 0) {
    await packs.createPackOdds(oddsToCreate);
    logger.info(`[e2e] Seeded ${oddsToCreate.length} pack-odds row(s).`);
  }

  // --- Eligible inventory product (card-management.spec.ts) ----------------
  // The admin lifecycle spec (register from inventory → FMV edit → storefront
  // reflection) only runs when GET /admin/gacha/eligible-products lists an
  // un-registered product with this handle. Eligibility = "a product whose
  // handle is not yet a Card". The prod seed registers all its products, so the
  // list is empty on a fresh DB — mint ONE un-registered product here (ported
  // from the hand-run create-test-product.ts). We create only the PRODUCT, never
  // a Card, so it stays eligible; the spec's beforeAll deletes any leftover card.
  const productModule = container.resolve(Modules.PRODUCT);
  const CARD_PRODUCT_HANDLE = 'pw-test-card';
  const [existingProduct] = await productModule.listProducts(
    { handle: CARD_PRODUCT_HANDLE },
    { take: 1 },
  );
  if (existingProduct) {
    logger.info('[e2e] Eligible test product already present, skipping.');
  } else {
    const ctx = await resolveCardProductContext(container);
    const input = buildCardProductInput(
      {
        handle: CARD_PRODUCT_HANDLE,
        title: 'PW Test Eligible Card',
        image: '/cdn/cards/celebi.webp', // reuse a seeded image
        price: 12.5,
        metadata: {
          fmv: 12.5,
          points: 90,
          grade: '9',
          grader: 'PSA',
          set: 'PW Test Set',
          year: 2026,
        },
      },
      {
        shippingProfileId: ctx.shippingProfileId,
        salesChannelId: ctx.salesChannelId,
        status: ProductStatus.PUBLISHED,
        manageInventory: false, // untracked => ∞ stock, drawable when pooled
      },
    );
    await createProductsWorkflow(container).run({
      input: {
        products: [input],
        additional_data: { seller_id: ctx.sellerId },
      },
    });
    logger.info(`[e2e] Seeded eligible test product '${CARD_PRODUCT_HANDLE}'.`);
  }

  // --- Claimable voucher grant (rewards.spec.ts) ---------------------------
  // rewards.spec.ts logs in as the shared dev customer and claims a 'granted'
  // voucher on /vip. That customer IS seeded (seed.ts's SEED_DEMO path, run by
  // deploy:init BEFORE this fixture in the nightly), but NO seed path mints the
  // grant — the spec header's "already holds granted vouchers" is aspirational.
  // Mint one here so the UI claim leg is exercisable (also needs the gate open:
  // REWARDS_REDEMPTION_ENABLED, set by e2e.yml). Ladder level-2 voucher — the
  // shape a real level-up mints.
  const customerModule = container.resolve(Modules.CUSTOMER);
  const REWARD_EMAIL = process.env.TEST_CUSTOMER_EMAIL ?? 'test@polycards.app';
  const [rewardCustomer] = await customerModule.listCustomers(
    { email: REWARD_EMAIL },
    { take: 1 },
  );
  if (!rewardCustomer) {
    // Not fatal: in the nightly deploy:init seeds this customer first. A local
    // seed:e2e without seed.ts's demo path lands here — warn loudly (a silent
    // skip is exactly the dark-spec problem this fixture fixes) and move on.
    logger.warn(
      `[e2e] Reward customer '${REWARD_EMAIL}' not found — skipping voucher ` +
        'grant. Run deploy:init (seed.ts, SEED_DEMO on) first; the nightly does.',
    );
  } else {
    // Idempotent by deterministic id: covers first-run (create), a re-run before
    // the spec claims it (sees 'granted'), and a re-run after a rewards.spec.ts
    // pass already CLAIMED it (sees 'fulfilled', or 'revoked' from a manual
    // op). Self-healing on that last case, not just idempotent: a claim
    // flips status via claimVipRewardGrant's updateVipRewardGrants (service.ts),
    // so without a reset here the fixture goes dark after the very first
    // successful nightly run instead of staying claimable on every run.
    const grantId = `vrg_e2e_${rewardCustomer.id}_voucher`;
    const [existingGrant] = await packs.listVipRewardGrants(
      { id: grantId },
      { take: 1 },
    );
    if (existingGrant && existingGrant.status === 'granted') {
      logger.info('[e2e] E2E voucher grant already present, skipping.');
    } else if (existingGrant) {
      // Reset in place (not delete+recreate): the row's id is the fixture's
      // deterministic key and the unique ladder index is scoped to it, so an
      // update is the smaller, safer move than a delete racing a re-create.
      await packs.updateVipRewardGrants([{ id: grantId, status: 'granted' }]);
      logger.info(
        `[e2e] E2E voucher grant was '${existingGrant.status}' — reset to ` +
          `'granted' for '${REWARD_EMAIL}'.`,
      );
    } else {
      await packs.createVipRewardGrants([
        {
          id: grantId,
          customer_id: rewardCustomer.id,
          level: 2,
          kind: 'voucher',
          payload: { amount_myr: 5 },
          status: 'granted',
          source_open_id: 'seed-e2e-fixtures',
        },
      ]);
      logger.info(
        `[e2e] Seeded claimable voucher grant for '${REWARD_EMAIL}'.`,
      );
    }
  }

  logger.info('[e2e] Fixture seed complete.');
}

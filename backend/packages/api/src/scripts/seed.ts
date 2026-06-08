import {
  CreateInventoryLevelInput,
  ExecArgs,
} from "@medusajs/framework/types";
import {
  ContainerRegistrationKeys,
  Modules,
  ProductStatus,
} from "@medusajs/framework/utils";
import {
  createWorkflow,
  transform,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk";
import {
  createApiKeysWorkflow,
  createInventoryLevelsWorkflow,
  createProductsWorkflow,
  createRegionsWorkflow,
  createSalesChannelsWorkflow,
  createShippingOptionsWorkflow,
  createShippingProfilesWorkflow,
  createStockLocationsWorkflow,
  createTaxRegionsWorkflow,
  deleteProductsWorkflow,
  linkSalesChannelsToApiKeyWorkflow,
  linkSalesChannelsToStockLocationWorkflow,
  updateStoresStep,
  updateStoresWorkflow,
} from "@medusajs/medusa/core-flows";
import { MercurModules, SellerStatus } from "@mercurjs/types";
import PacksModuleService from "../modules/packs/service";
import { PACKS_MODULE } from "../modules/packs";

const updateStoreCurrencies = createWorkflow(
  "update-store-currencies",
  (input: {
    supported_currencies: { currency_code: string; is_default?: boolean }[];
    store_id: string;
  }) => {
    const normalizedInput = transform({ input }, (data) => {
      return {
        selector: { id: data.input.store_id },
        update: {
          supported_currencies: data.input.supported_currencies.map(
            (currency) => {
              return {
                currency_code: currency.currency_code,
                is_default: currency.is_default ?? false,
              };
            }
          ),
        },
      };
    });

    const stores = updateStoresStep(normalizedInput);

    return new WorkflowResponse(stores);
  }
);

// ---------------------------------------------------------------------------
// Pokénic card catalog — the single source of truth for the marketplace.
//
// Seeded as products owned by a "house" seller because Mercur's store API only
// surfaces a product when it is linked to a seller whose status is "open"
// (see @mercurjs/core store/products `applyVisibleSellerIdsFilter`). The
// storefront reads these back through the Store API; `handle` doubles as the
// `/card/<slug>` route id, and `metadata` carries the card-specific facts
// (fmv/points/grade/grader/set/rarity/year) that are not first-class Medusa
// product fields. Images are local assets under the storefront's
// public/cdn/cards/ and are stored as site-relative URLs.
// ---------------------------------------------------------------------------
const HOUSE_SELLER = {
  name: "House",
  handle: "house",
  email: "house@pokenic.local",
} as const;

// Only 7 real graded-slab images were harvested from the live site; the 16
// listings intentionally reuse them (matching the original clone's static data).
// Each id maps to an existing public/cdn/cards/<id>.webp — adding a new card
// without a real image should reuse one of these, not invent a missing filename.
const CARD_IMG = {
  celebi: "FQEYWuGiKTkJpZSG6XqGHDBmH6EmxctEqk1kAT2MYzHc",
  mewtwo: "9kRLkdbbvzm335GBvraQrWrNVs72gzEzynvP1RPvftTx",
  darkrai: "4h13RDtFX4MWNYjvgMPeBS1hcL4AewupiFzDvyFUUTkd",
  jolteon: "BEnddEeBXBHyL5qWXCg6sKS5VmUbUtZaKJ1aVB8yCWHN",
  rapidash: "FFbo5jfXHHQWN8bmc88UDYSDP5QzYCCj6RwUkiWYyffC",
  hooh: "FjAJZ7en585MpnoLUGbuALHEmbBAPd61EZCefQzFMmRX",
  gengar: "6noxMybjBLtLqicAUTrG63VhWG2FgWzDBsQGnnZEyNCG",
} as const;

const cardImage = (id: string) => `/cdn/cards/${id}.webp`;

// The 5 gacha rarity tiers. Typing CardSeed.rarity as this union (not string)
// makes a rarity typo a compile error instead of a silent RARITY_WEIGHT miss.
type Rarity = "Legendary" | "Epic" | "Rare" | "Uncommon" | "Common";

type CardSeed = {
  handle: string;
  title: string;
  price: number; // USD listing price
  fmv: number; // USD fair-market value
  points: number;
  grade: string;
  grader: string;
  set: string;
  rarity: Rarity;
  year: number;
  image: string;
  // Gacha pool key — MUST match a Pack.category exactly (pokemon | one-piece |
  // basketball | baseball | football | soccer | yugioh | riftbound). Omitted ==
  // "pokemon" (the original 16). Only used at seed time to scope which PackOdds
  // rows are built, so a pack only pulls cards of its own category — it is NOT a
  // Card-model field (nothing queries cards by category at runtime).
  category?: string;
};

// Clean, un-watermarked category card slabs (public/home/hero/slabs/<name>.webp).
// The generic /cdn/cards/h-NNN.webp slabs are all phygitals-watermarked Pokemon
// and intentionally unused here; soccer/riftbound have no native slab art and
// reuse the nearest sport/TCG slab as a stand-in (the card NAME carries the
// category, matching the image-reuse the original 16 Pokemon listings already do).
const slabImage = (name: string) => `/home/hero/slabs/${name}.webp`;

const CARD_PRODUCTS: CardSeed[] = [
  {
    handle: "celebi",
    title:
      "2021 Pokemon Japanese Sword & Shield Jet-Black Spirit Celebi V #3 CGC 10 GEM MINT",
    price: 18.4,
    fmv: 19.2,
    points: 93,
    grade: "10 GEM MINT",
    grader: "CGC",
    set: "Jet-Black Spirit",
    rarity: "Rare",
    year: 2021,
    image: cardImage(CARD_IMG.celebi),
  },
  {
    handle: "mewtwo",
    title:
      "2025 Pokemon Japanese SV Glory Of Rocket Gang Holo Team Rockets Mewtwo ex CGC 10",
    price: 24.75,
    fmv: 23.9,
    points: 100,
    grade: "10 GEM MINT",
    grader: "CGC",
    set: "Glory of Team Rocket",
    rarity: "Rare",
    year: 2025,
    image: cardImage(CARD_IMG.mewtwo),
  },
  {
    handle: "darkrai-gg",
    title:
      "2023 Pokemon Sword and Shield Crown Zenith Galarian Gallery Darkrai Vstar #GG50 PSA 10",
    price: 41.2,
    fmv: 39.8,
    points: 100,
    grade: "10",
    grader: "PSA",
    set: "Crown Zenith",
    rarity: "Epic",
    year: 2023,
    image: cardImage(CARD_IMG.darkrai),
  },
  {
    handle: "jolteon",
    title:
      "2024 Pokemon Japanese Scarlet & Violet Terastal Fest ex Holo Jolteon ex #52 CGC 10 PRISTINE",
    price: 15.6,
    fmv: 16.1,
    points: 96,
    grade: "10 PRISTINE",
    grader: "CGC",
    set: "Terastal Festival ex",
    rarity: "Uncommon",
    year: 2024,
    image: cardImage(CARD_IMG.jolteon),
  },
  {
    handle: "shaymin",
    title:
      "2022 Pokemon Japanese Sword & Shield Star Birth Holo Shaymin VSTAR #13 CGC 9.5 MINT+",
    price: 12.9,
    fmv: 13.4,
    points: 95,
    grade: "9.5 MINT+",
    grader: "CGC",
    set: "Star Birth",
    rarity: "Uncommon",
    year: 2022,
    image: cardImage(CARD_IMG.celebi),
  },
  {
    handle: "rapidash",
    title:
      "2025 Pokemon Japanese Mega Start Deck 100 Battle Collection Reverse Holo Rapidash #90 CGC 10",
    price: 8.45,
    fmv: 8.9,
    points: 92,
    grade: "10",
    grader: "CGC",
    set: "Battle Collection",
    rarity: "Common",
    year: 2025,
    image: cardImage(CARD_IMG.rapidash),
  },
  {
    handle: "hooh",
    title:
      "2022 Pokemon Japanese Sword & Shield Incandescent Arcana Ho-Oh V #55 CGC 10 GEM MINT",
    price: 21.3,
    fmv: 20.5,
    points: 98,
    grade: "10 GEM MINT",
    grader: "CGC",
    set: "Incandescent Arcana",
    rarity: "Rare",
    year: 2022,
    image: cardImage(CARD_IMG.hooh),
  },
  {
    handle: "gengar",
    title:
      "2023 Pokemon Japanese Scarlet & Violet 151 Holo Gengar #94 CGC 10 GEM MINT",
    price: 29.99,
    fmv: 31.2,
    points: 100,
    grade: "10 GEM MINT",
    grader: "CGC",
    set: "Scarlet & Violet 151",
    rarity: "Epic",
    year: 2023,
    image: cardImage(CARD_IMG.gengar),
  },
  {
    handle: "espathra",
    title:
      "2023 Pokemon Scarlet & Violet Paradox Rift Reverse Holo Espathra #081 CGC 8.5 NM-MT+",
    price: 9.59,
    fmv: 9.96,
    points: 90,
    grade: "8.5 NM-MT+",
    grader: "CGC",
    set: "Paradox Rift",
    rarity: "Common",
    year: 2023,
    image: cardImage(CARD_IMG.gengar),
  },
  {
    handle: "mimikyu",
    title:
      "2021 Pokemon Japanese SWSH VMAX Climax Mimikyu VMAX #77 CGC 8.5 NM-MT+",
    price: 9.33,
    fmv: 9.96,
    points: 92,
    grade: "8.5 NM-MT+",
    grader: "CGC",
    set: "VMAX Climax",
    rarity: "Common",
    year: 2021,
    image: cardImage(CARD_IMG.celebi),
  },
  {
    handle: "lycanroc",
    title:
      "2016 Pokemon Japanese Sun & Moon Rockruff Full Power Deck Holo Lycanroc GX #9 CGC 5.5",
    price: 7.8,
    fmv: 8.4,
    points: 92,
    grade: "5.5",
    grader: "CGC",
    set: "Sun & Moon",
    rarity: "Common",
    year: 2016,
    image: cardImage(CARD_IMG.rapidash),
  },
  {
    handle: "garchomp",
    title:
      "2025 Pokemon Japanese Mega Dream ex Holo Cynthia's Garchomp ex #90 CGC 8.5 NM-MT+",
    price: 9.1,
    fmv: 9.5,
    points: 92,
    grade: "8.5 NM-MT+",
    grader: "CGC",
    set: "Mega Dream ex",
    rarity: "Common",
    year: 2025,
    image: cardImage(CARD_IMG.mewtwo),
  },
  {
    handle: "ribombee",
    title:
      "2025 Pokemon Scarlet & Violet Journey Together Holo Lillie's Ribombee #67 CGC 9.5 MINT",
    price: 11.2,
    fmv: 10.8,
    points: 97,
    grade: "9.5 MINT",
    grader: "CGC",
    set: "Journey Together",
    rarity: "Uncommon",
    year: 2025,
    image: cardImage(CARD_IMG.jolteon),
  },
  {
    handle: "obstagoon",
    title:
      "2023 Pokemon Sword & Shield Fusion Strike K.O. Collection Galarian Obstagoon #161 CGC 9",
    price: 12.0,
    fmv: 11.5,
    points: 100,
    grade: "9",
    grader: "CGC",
    set: "Fusion Strike",
    rarity: "Uncommon",
    year: 2023,
    image: cardImage(CARD_IMG.hooh),
  },
  {
    handle: "darkrai-tot",
    title:
      "2024 Pokemon Scarlet & Violet Obsidian Flames Trick Or Trade Holo Darkrai #136 CGC 9.5",
    price: 13.4,
    fmv: 12.9,
    points: 100,
    grade: "9.5",
    grader: "CGC",
    set: "Obsidian Flames",
    rarity: "Uncommon",
    year: 2024,
    image: cardImage(CARD_IMG.darkrai),
  },
  {
    handle: "dustox",
    title: "2025 Pokemon Japanese Mega Dream ex AR Dustox #195 CGC 9 MINT",
    price: 10.2,
    fmv: 9.25,
    points: 100,
    grade: "9 MINT",
    grader: "CGC",
    set: "Mega Dream ex",
    rarity: "Common",
    year: 2025,
    image: cardImage(CARD_IMG.celebi),
  },

  // ---- Per-category gacha pools (Phase 8) -------------------------------------
  // One card per rarity for each non-Pokemon category so every pack's published
  // odds span a real spread. Real-ish names on the clean hero-slab art; images
  // are reused within a category (as the 16 Pokemon listings reuse 7 images).

  // basketball — basketball1 = Alonzo Mourning PMG, basketball2/3 = Michael Jordan
  { handle: "nba-jordan-pmg", title: "1997 Metal Universe Championship Michael Jordan #23 Precious Metal Gems PSA 9", price: 140, fmv: 142, points: 95, grade: "9 MINT", grader: "PSA", set: "Metal Universe Championship", rarity: "Legendary", year: 1997, image: slabImage("basketball2"), category: "basketball" },
  { handle: "nba-jordan-metal", title: "1998 Skybox Metal Universe Michael Jordan #23 BGS 9.5 GEM MINT", price: 62, fmv: 63.5, points: 98, grade: "9.5 GEM MINT", grader: "BGS", set: "Metal Universe", rarity: "Epic", year: 1998, image: slabImage("basketball3"), category: "basketball" },
  { handle: "nba-mourning-pmg", title: "1997 Metal Universe Championship Alonzo Mourning #13 Precious Metal Gems PSA 5", price: 30, fmv: 31.2, points: 75, grade: "5 EX", grader: "PSA", set: "Metal Universe Championship", rarity: "Rare", year: 1997, image: slabImage("basketball1"), category: "basketball" },
  { handle: "nba-mourning-heat", title: "1998 Skybox Alonzo Mourning Miami Heat CGC 8.5 NM-MT+", price: 15, fmv: 14.8, points: 92, grade: "8.5 NM-MT+", grader: "CGC", set: "Skybox", rarity: "Uncommon", year: 1998, image: slabImage("basketball1"), category: "basketball" },
  { handle: "nba-heat-base", title: "1997 Metal Universe Miami Heat Team Card PSA 7 NM", price: 8, fmv: 7.75, points: 85, grade: "7 NM", grader: "PSA", set: "Metal Universe", rarity: "Common", year: 1997, image: slabImage("basketball2"), category: "basketball" },

  // football — football1 = Donruss Downtown, football3/4 = National Treasures RPA
  { handle: "nfl-downtown", title: "2023 Donruss Downtown Patrick Mahomes Kansas City Chiefs BGS 9.5", price: 120, fmv: 124, points: 98, grade: "9.5 GEM MINT", grader: "BGS", set: "Donruss Downtown", rarity: "Legendary", year: 2023, image: slabImage("football1"), category: "football" },
  { handle: "nfl-nt-purdy", title: "2023 National Treasures Brock Purdy Rookie Patch Auto /99 PSA 10", price: 66, fmv: 67.5, points: 100, grade: "10 GEM MINT", grader: "PSA", set: "National Treasures", rarity: "Epic", year: 2023, image: slabImage("football3"), category: "football" },
  { handle: "nfl-nt-rpa", title: "2023 National Treasures Rookie Patch Autograph /99 BGS 9", price: 28, fmv: 29.4, points: 95, grade: "9 MINT", grader: "BGS", set: "National Treasures", rarity: "Rare", year: 2023, image: slabImage("football4"), category: "football" },
  { handle: "nfl-prizm-rc", title: "2023 Panini Prizm Rookie CGC 8.5 NM-MT+", price: 14, fmv: 13.6, points: 92, grade: "8.5 NM-MT+", grader: "CGC", set: "Prizm", rarity: "Uncommon", year: 2023, image: slabImage("football3"), category: "football" },
  { handle: "nfl-donruss-base", title: "2023 Donruss NFL Base PSA 7 NM", price: 7, fmv: 6.5, points: 85, grade: "7 NM", grader: "PSA", set: "Donruss", rarity: "Common", year: 2023, image: slabImage("football1"), category: "football" },

  // baseball — baseball1 = 1968 Topps Mickey Mantle (only one slab; reused)
  { handle: "mlb-mantle-ex", title: "1968 Topps Mickey Mantle #280 New York Yankees PSA 5 EX", price: 150, fmv: 155, points: 75, grade: "5 EX", grader: "PSA", set: "Topps", rarity: "Legendary", year: 1968, image: slabImage("baseball1"), category: "baseball" },
  { handle: "mlb-mantle-vg", title: "1968 Topps Mickey Mantle #280 New York Yankees PSA 3 VG", price: 60, fmv: 58, points: 60, grade: "3 VG", grader: "PSA", set: "Topps", rarity: "Epic", year: 1968, image: slabImage("baseball1"), category: "baseball" },
  { handle: "mlb-yankees-team", title: "1968 Topps New York Yankees Team Card #490 PSA 6 EX-MT", price: 26, fmv: 25.4, points: 80, grade: "6 EX-MT", grader: "PSA", set: "Topps", rarity: "Rare", year: 1968, image: slabImage("baseball1"), category: "baseball" },
  { handle: "mlb-topps-base", title: "1968 Topps Baseball Base CGC 7.5 NM+", price: 13, fmv: 12.6, points: 88, grade: "7.5 NM+", grader: "CGC", set: "Topps", rarity: "Uncommon", year: 1968, image: slabImage("baseball1"), category: "baseball" },
  { handle: "mlb-common", title: "1968 Topps Baseball Common PSA 6 EX-MT", price: 7, fmv: 6.4, points: 80, grade: "6 EX-MT", grader: "PSA", set: "Topps", rarity: "Common", year: 1968, image: slabImage("baseball1"), category: "baseball" },

  // one-piece — onepiece4 = Monkey D. Luffy, onepiece2 = TCG holo
  { handle: "op-luffy", title: "2024 One Piece TCG Monkey D. Luffy Leader Parallel CGC 10", price: 95, fmv: 97, points: 100, grade: "10 GEM MINT", grader: "CGC", set: "OP-01 Romance Dawn", rarity: "Legendary", year: 2024, image: slabImage("onepiece4"), category: "one-piece" },
  { handle: "op-zoro", title: "2024 One Piece TCG Roronoa Zoro Super Parallel PSA 10", price: 55, fmv: 56.5, points: 100, grade: "10 GEM MINT", grader: "PSA", set: "Paramount War", rarity: "Epic", year: 2024, image: slabImage("onepiece2"), category: "one-piece" },
  { handle: "op-shanks", title: "2024 One Piece TCG Shanks Leader Rare BGS 9.5", price: 26, fmv: 26.8, points: 98, grade: "9.5 GEM MINT", grader: "BGS", set: "OP-01 Romance Dawn", rarity: "Rare", year: 2024, image: slabImage("onepiece2"), category: "one-piece" },
  { handle: "op-nami", title: "2024 One Piece TCG Nami Uncommon CGC 9 MINT", price: 14, fmv: 13.9, points: 95, grade: "9 MINT", grader: "CGC", set: "Paramount War", rarity: "Uncommon", year: 2024, image: slabImage("onepiece4"), category: "one-piece" },
  { handle: "op-common", title: "2024 One Piece TCG Common CGC 8 NM-MT", price: 7, fmv: 6.75, points: 90, grade: "8 NM-MT", grader: "CGC", set: "Romance Dawn", rarity: "Common", year: 2024, image: slabImage("onepiece2"), category: "one-piece" },

  // yugioh — yugioh2 = Summoned Skull, yugioh1 = classic monster
  { handle: "ygo-summoned-skull", title: "2002 Yu-Gi-Oh Summoned Skull MRD-061 1st Edition PSA 10", price: 100, fmv: 104, points: 100, grade: "10 GEM MINT", grader: "PSA", set: "Metal Raiders", rarity: "Legendary", year: 2002, image: slabImage("yugioh2"), category: "yugioh" },
  { handle: "ygo-blue-eyes", title: "2002 Yu-Gi-Oh Blue-Eyes White Dragon LOB-001 BGS 9.5", price: 60, fmv: 61.5, points: 98, grade: "9.5 GEM MINT", grader: "BGS", set: "Legend of Blue Eyes White Dragon", rarity: "Epic", year: 2002, image: slabImage("yugioh1"), category: "yugioh" },
  { handle: "ygo-dark-magician", title: "2002 Yu-Gi-Oh Dark Magician LOB-005 Rare CGC 9", price: 28, fmv: 28.9, points: 95, grade: "9 MINT", grader: "CGC", set: "Legend of Blue Eyes White Dragon", rarity: "Rare", year: 2002, image: slabImage("yugioh1"), category: "yugioh" },
  { handle: "ygo-kuriboh", title: "2003 Yu-Gi-Oh Kuriboh Uncommon CGC 8.5 NM-MT+", price: 13, fmv: 12.4, points: 92, grade: "8.5 NM-MT+", grader: "CGC", set: "Metal Raiders", rarity: "Uncommon", year: 2003, image: slabImage("yugioh2"), category: "yugioh" },
  { handle: "ygo-common", title: "2002 Yu-Gi-Oh Metal Raiders Common PSA 8 NM-MT", price: 6, fmv: 5.8, points: 90, grade: "8 NM-MT", grader: "PSA", set: "Metal Raiders", rarity: "Common", year: 2002, image: slabImage("yugioh1"), category: "yugioh" },

  // soccer — no native slab art; reuse football slabs as a sports-card stand-in
  { handle: "soccer-messi", title: "2022 Topps Chrome Lionel Messi Argentina World Cup PSA 10", price: 130, fmv: 134, points: 100, grade: "10 GEM MINT", grader: "PSA", set: "Topps Chrome", rarity: "Legendary", year: 2022, image: slabImage("football1"), category: "soccer" },
  { handle: "soccer-ronaldo", title: "2021 Panini Prizm Cristiano Ronaldo Manchester United BGS 9.5", price: 64, fmv: 65.5, points: 98, grade: "9.5 GEM MINT", grader: "BGS", set: "Prizm", rarity: "Epic", year: 2021, image: slabImage("football3"), category: "soccer" },
  { handle: "soccer-mbappe", title: "2022 Topps Chrome Kylian Mbappe France PSA 9", price: 30, fmv: 30.6, points: 95, grade: "9 MINT", grader: "PSA", set: "Topps Chrome", rarity: "Rare", year: 2022, image: slabImage("football4"), category: "soccer" },
  { handle: "soccer-haaland", title: "2023 Panini Prizm Erling Haaland Manchester City CGC 8.5", price: 15, fmv: 14.7, points: 92, grade: "8.5 NM-MT+", grader: "CGC", set: "Prizm", rarity: "Uncommon", year: 2023, image: slabImage("football1"), category: "soccer" },
  { handle: "soccer-base", title: "2022 Topps Chrome UEFA Champions League Base PSA 7", price: 7, fmv: 6.6, points: 85, grade: "7 NM", grader: "PSA", set: "Topps Chrome", rarity: "Common", year: 2022, image: slabImage("football3"), category: "soccer" },

  // riftbound (League of Legends TCG) — no native slab art; reuse yugioh TCG slabs
  { handle: "riftbound-jinx", title: "2025 Riftbound League of Legends Jinx Hyperpop Foil PSA 10", price: 110, fmv: 113, points: 100, grade: "10 GEM MINT", grader: "PSA", set: "Riftbound Origins", rarity: "Legendary", year: 2025, image: slabImage("yugioh2"), category: "riftbound" },
  { handle: "riftbound-ahri", title: "2025 Riftbound Ahri Spirit Blossom Holo BGS 9.5", price: 58, fmv: 59.5, points: 98, grade: "9.5 GEM MINT", grader: "BGS", set: "Riftbound Origins", rarity: "Epic", year: 2025, image: slabImage("yugioh1"), category: "riftbound" },
  { handle: "riftbound-yasuo", title: "2025 Riftbound Yasuo Champion Rare CGC 9", price: 27, fmv: 27.5, points: 95, grade: "9 MINT", grader: "CGC", set: "Riftbound Origins", rarity: "Rare", year: 2025, image: slabImage("yugioh2"), category: "riftbound" },
  { handle: "riftbound-lux", title: "2025 Riftbound Lux Uncommon CGC 8.5 NM-MT+", price: 13, fmv: 12.5, points: 92, grade: "8.5 NM-MT+", grader: "CGC", set: "Riftbound Origins", rarity: "Uncommon", year: 2025, image: slabImage("yugioh1"), category: "riftbound" },
  { handle: "riftbound-base", title: "2025 Riftbound Origins Base PSA 8 NM-MT", price: 7, fmv: 6.8, points: 90, grade: "8 NM-MT", grader: "PSA", set: "Riftbound Origins", rarity: "Common", year: 2025, image: slabImage("yugioh2"), category: "riftbound" },
];

const CARD_HANDLES = CARD_PRODUCTS.map((c) => c.handle);
// Handle = the storefront's /card/<slug> id and the seed's idempotency key, so a
// duplicate would silently drop a card (the existing-handle guard dedupes it).
// Fail fast at load instead of seeding a short catalog.
if (new Set(CARD_HANDLES).size !== CARD_HANDLES.length) {
  throw new Error("CARD_PRODUCTS contains duplicate handles");
}
const DEMO_APPAREL_HANDLES = ["t-shirt", "sweatshirt", "sweatpants", "shorts"];

// ---------------------------------------------------------------------------
// Gacha pack catalog (Phase 4) — mirrors the storefront's
// src/app/claw/packs-data.ts so /claw and the home "Open Packs" tiles can read
// real backend packs. `slug` matches the storefront pack id (= /claw/<slug>
// route), `category` is a stable key the storefront maps to labels/icons, and
// `rank` is the display order within a category. Prices are whole-dollar USD
// decimals (Medusa stores prices as-is, never cents). Backend & storefront are
// separate workspaces so the list is duplicated by design (as CARD_PRODUCTS is
// vs. the storefront CARD_POOL); the storefront also keeps these as its
// backend-down fallback.
// ---------------------------------------------------------------------------
type PackSeed = {
  slug: string;
  title: string;
  price: number;
  image: string;
  category: string;
  rank: number;
  boost: boolean;
};

const clawIcon = (base: string) => `/images/claw/${base}-icon.webp`;

const PACK_SEED_GROUPS: {
  category: string;
  packs: { slug: string; title: string; price: number; image: string; boost?: boolean }[];
}[] = [
  {
    category: "pokemon",
    packs: [
      { slug: "pokemon-mythic", title: "Mythic Pack", price: 1000, image: clawIcon("mythic-pack"), boost: true },
      { slug: "pokemon-legend", title: "Legend Pack", price: 250, image: clawIcon("legend-pack"), boost: true },
      { slug: "pokemon-elite", title: "Elite Pack", price: 50, image: clawIcon("elite-pack") },
      { slug: "pokemon-platinum", title: "Platinum Pack", price: 500, image: clawIcon("platinum-pack"), boost: true },
      { slug: "pokemon-rookie", title: "Rookie Pack", price: 25, image: clawIcon("rookie-pack") },
    ],
  },
  {
    category: "one-piece",
    packs: [
      { slug: "onepiece-legend", title: "Legend Pack", price: 250, image: clawIcon("legend-one-piece-pack"), boost: true },
      { slug: "onepiece-platinum", title: "Platinum Pack", price: 500, image: clawIcon("one-piece-platinum-pack"), boost: true },
      { slug: "onepiece-elite", title: "Elite Pack", price: 50, image: clawIcon("elite-one-piece-pack") },
      { slug: "onepiece-starter", title: "Starter Pack", price: 25, image: clawIcon("starter-one-piece-pack") },
    ],
  },
  {
    category: "basketball",
    packs: [
      { slug: "nba-black", title: "Black Pack", price: 1000, image: clawIcon("black-pack-jjnfuk"), boost: true },
      { slug: "nba-legend", title: "Legend Pack", price: 250, image: clawIcon("legend-pack-1dpaec"), boost: true },
      { slug: "nba-platinum", title: "Platinum Pack", price: 500, image: clawIcon("modern-grails-noafw0"), boost: true },
    ],
  },
  {
    category: "baseball",
    packs: [
      { slug: "baseball-pro", title: "Pro Pack", price: 100, image: clawIcon("pro-baseball-pack") },
      { slug: "baseball-legend", title: "Legend Pack", price: 250, image: clawIcon("legend-baseball-pack"), boost: true },
      { slug: "baseball-starter", title: "Starter Pack", price: 25, image: clawIcon("starter-baseball-pack") },
    ],
  },
  {
    category: "football",
    packs: [
      { slug: "football-elite", title: "Elite Pack", price: 50, image: clawIcon("elite-football-pack") },
      { slug: "football-starter", title: "Starter Pack", price: 25, image: clawIcon("starter-football-pack") },
      { slug: "football-platinum", title: "Platinum Pack", price: 500, image: clawIcon("platinum-football-pack"), boost: true },
    ],
  },
  {
    category: "soccer",
    packs: [{ slug: "soccer-pro", title: "Pro Pack", price: 100, image: clawIcon("pro-soccer-pack") }],
  },
  {
    category: "yugioh",
    packs: [{ slug: "yugioh-pro", title: "Pro Pack", price: 25, image: clawIcon("yugioh-pro-pack") }],
  },
  {
    category: "riftbound",
    packs: [{ slug: "riftbound-starter", title: "Starter Pack", price: 25, image: clawIcon("starter-riftbound-pack") }],
  },
];

const PACK_SEED: PackSeed[] = PACK_SEED_GROUPS.flatMap((group) =>
  group.packs.map((pack, index) => ({
    slug: pack.slug,
    title: pack.title,
    price: pack.price,
    image: pack.image,
    category: group.category,
    rank: index,
    boost: pack.boost ?? false,
  }))
);

const PACK_SLUGS = PACK_SEED.map((p) => p.slug);
// slug is the storefront route id AND this seed's idempotency key, so a
// duplicate would silently drop a pack — fail fast instead.
if (new Set(PACK_SLUGS).size !== PACK_SLUGS.length) {
  throw new Error("PACK_SEED contains duplicate slugs");
}

export default async function seedDemoData({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const link = container.resolve(ContainerRegistrationKeys.LINK);
  const query = container.resolve(ContainerRegistrationKeys.QUERY);
  const fulfillmentModuleService = container.resolve(Modules.FULFILLMENT);
  const salesChannelModuleService = container.resolve(Modules.SALES_CHANNEL);
  const storeModuleService = container.resolve(Modules.STORE);

  const countries = ["gb", "de", "dk", "se", "fr", "es", "it"];

  logger.info("Seeding store data...");
  const [store] = await storeModuleService.listStores();
  let defaultSalesChannel = await salesChannelModuleService.listSalesChannels({
    name: "Default Sales Channel",
  });

  if (!defaultSalesChannel.length) {
    // create the default sales channel
    const { result: salesChannelResult } = await createSalesChannelsWorkflow(
      container
    ).run({
      input: {
        salesChannelsData: [
          {
            name: "Default Sales Channel",
          },
        ],
      },
    });
    defaultSalesChannel = salesChannelResult;
  }

  await updateStoreCurrencies(container).run({
    input: {
      store_id: store.id,
      supported_currencies: [
        {
          currency_code: "eur",
          is_default: true,
        },
        {
          currency_code: "usd",
        },
      ],
    },
  });

  await updateStoresWorkflow(container).run({
    input: {
      selector: { id: store.id },
      update: {
        default_sales_channel_id: defaultSalesChannel[0].id,
      },
    },
  });
  logger.info("Seeding region data...");
  const regionModuleService = container.resolve(Modules.REGION);

  // Check if any of the countries are already assigned to a region
  const existingRegions = await regionModuleService.listRegions({}, {
    relations: ["countries"],
  });

  const assignedCountries = new Set<string>();
  for (const r of existingRegions) {
    for (const c of r.countries || []) {
      assignedCountries.add(c.iso_2);
    }
  }

  const unassignedCountries = countries.filter(c => !assignedCountries.has(c));

  let region;
  if (unassignedCountries.length === 0) {
    // All countries already assigned - find the region that has most of our countries
    region = existingRegions.find(r =>
      r.countries?.some(c => countries.includes(c.iso_2))
    ) || existingRegions[0];
    logger.info("Countries already assigned to a region, skipping region creation.");
  } else if (unassignedCountries.length < countries.length) {
    // Some countries assigned, some not - only create with unassigned ones
    logger.info(`Some countries already assigned, creating region with: ${unassignedCountries.join(", ")}`);
    const { result: regionResult } = await createRegionsWorkflow(container).run({
      input: {
        regions: [
          {
            name: "Europe",
            currency_code: "eur",
            countries: unassignedCountries,
            payment_providers: ["pp_system_default"],
          },
        ],
      },
    });
    region = regionResult[0];
  } else {
    // No countries assigned - create full region
    const { result: regionResult } = await createRegionsWorkflow(container).run({
      input: {
        regions: [
          {
            name: "Europe",
            currency_code: "eur",
            countries,
            payment_providers: ["pp_system_default"],
          },
        ],
      },
    });
    region = regionResult[0];
  }

  // USD region — the storefront prices and displays cards in USD, so it queries
  // `/store/products` with this region's id to resolve `calculated_price` in USD
  // (card variants carry USD prices). Guarded by currency so re-runs are no-ops.
  const allRegions = await regionModuleService.listRegions({});
  let usdRegion = allRegions.find((r) => r.currency_code === "usd");
  if (!usdRegion) {
    // Only claim "us" if no existing region already has it (countries are unique
    // to one region); a USD region with no country still resolves USD prices.
    const usdCountries = assignedCountries.has("us") ? [] : ["us"];
    const { result: usdRegionResult } = await createRegionsWorkflow(
      container
    ).run({
      input: {
        regions: [
          {
            name: "United States",
            currency_code: "usd",
            countries: usdCountries,
            payment_providers: ["pp_system_default"],
          },
        ],
      },
    });
    usdRegion = usdRegionResult[0];
    logger.info(`Created USD region (${usdRegion.id}).`);
  } else {
    logger.info("USD region already exists, skipping.");
  }
  logger.info("Finished seeding regions.");

  logger.info("Seeding tax regions...");
  const taxModuleService = container.resolve(Modules.TAX);
  const existingTaxRegions = await taxModuleService.listTaxRegions();
  const existingCountryCodes = new Set(existingTaxRegions.map((tr) => tr.country_code));
  const countriesToCreate = countries.filter((c) => !existingCountryCodes.has(c));

  if (countriesToCreate.length > 0) {
    await createTaxRegionsWorkflow(container).run({
      input: countriesToCreate.map((country_code) => ({
        country_code,
        provider_id: "tp_system",
      })),
    });
  } else {
    logger.info("Tax regions already exist, skipping.");
  }
  logger.info("Finished seeding tax regions.");

  logger.info("Seeding stock location data...");
  const stockLocationModule = container.resolve(Modules.STOCK_LOCATION);
  const existingStockLocations = await stockLocationModule.listStockLocations({
    name: "European Warehouse",
  });

  let stockLocation;
  if (existingStockLocations.length) {
    stockLocation = existingStockLocations[0];
    logger.info("Stock location 'European Warehouse' already exists, skipping.");
  } else {
    const { result: stockLocationResult } = await createStockLocationsWorkflow(
      container
    ).run({
      input: {
        locations: [
          {
            name: "European Warehouse",
            address: {
              city: "Copenhagen",
              country_code: "DK",
              address_1: "",
            },
          },
        ],
      },
    });
    stockLocation = stockLocationResult[0];
  }

  await updateStoresWorkflow(container).run({
    input: {
      selector: { id: store.id },
      update: {
        default_location_id: stockLocation.id,
      },
    },
  });

  // Link stock location to fulfillment provider (idempotent)
  try {
    await link.create({
      [Modules.STOCK_LOCATION]: {
        stock_location_id: stockLocation.id,
      },
      [Modules.FULFILLMENT]: {
        fulfillment_provider_id: "manual_manual",
      },
    });
  } catch (error: unknown) {
    // Ignore if link already exists
    if (!(error instanceof Error && error.message.includes("already exists"))) {
      throw error;
    }
    logger.info("Stock location already linked to fulfillment provider, skipping.");
  }

  logger.info("Seeding fulfillment data...");
  const shippingProfiles = await fulfillmentModuleService.listShippingProfiles({
    type: "default",
  });
  let shippingProfile = shippingProfiles.length ? shippingProfiles[0] : null;

  if (!shippingProfile) {
    const { result: shippingProfileResult } =
      await createShippingProfilesWorkflow(container).run({
        input: {
          data: [
            {
              name: "Default Shipping Profile",
              type: "default",
            },
          ],
        },
      });
    shippingProfile = shippingProfileResult[0];
  }

  const existingFulfillmentSets = await fulfillmentModuleService.listFulfillmentSets({
    name: "European Warehouse delivery",
  });

  let fulfillmentSet;
  if (existingFulfillmentSets.length) {
    fulfillmentSet = existingFulfillmentSets[0];
    logger.info("Fulfillment set 'European Warehouse delivery' already exists, skipping.");
  } else {
    fulfillmentSet = await fulfillmentModuleService.createFulfillmentSets({
      name: "European Warehouse delivery",
      type: "shipping",
      service_zones: [
        {
          name: "Europe",
          geo_zones: [
            {
              country_code: "gb",
              type: "country",
            },
            {
              country_code: "de",
              type: "country",
            },
            {
              country_code: "dk",
              type: "country",
            },
            {
              country_code: "se",
              type: "country",
            },
            {
              country_code: "fr",
              type: "country",
            },
            {
              country_code: "es",
              type: "country",
            },
            {
              country_code: "it",
              type: "country",
            },
          ],
        },
      ],
    });

    try {
      await link.create({
        [Modules.STOCK_LOCATION]: {
          stock_location_id: stockLocation.id,
        },
        [Modules.FULFILLMENT]: {
          fulfillment_set_id: fulfillmentSet.id,
        },
      });
    } catch (error: unknown) {
      if (!(error instanceof Error && error.message.includes("already exists"))) {
        throw error;
      }
    }

    await createShippingOptionsWorkflow(container).run({
      input: [
        {
          name: "Standard Shipping",
          price_type: "flat",
          provider_id: "manual_manual",
          service_zone_id: fulfillmentSet.service_zones[0].id,
          shipping_profile_id: shippingProfile.id,
          type: {
            label: "Standard",
            description: "Ship in 2-3 days.",
            code: "standard",
          },
          prices: [
            {
              currency_code: "usd",
              amount: 10,
            },
            {
              currency_code: "eur",
              amount: 10,
            },
            {
              region_id: region.id,
              amount: 10,
            },
          ],
          rules: [
            {
              attribute: "enabled_in_store",
              value: "true",
              operator: "eq",
            },
            {
              attribute: "is_return",
              value: "false",
              operator: "eq",
            },
          ],
        },
        {
          name: "Express Shipping",
          price_type: "flat",
          provider_id: "manual_manual",
          service_zone_id: fulfillmentSet.service_zones[0].id,
          shipping_profile_id: shippingProfile.id,
          type: {
            label: "Express",
            description: "Ship in 24 hours.",
            code: "express",
          },
          prices: [
            {
              currency_code: "usd",
              amount: 10,
            },
            {
              currency_code: "eur",
              amount: 10,
            },
            {
              region_id: region.id,
              amount: 10,
            },
          ],
          rules: [
            {
              attribute: "enabled_in_store",
              value: "true",
              operator: "eq",
            },
            {
              attribute: "is_return",
              value: "false",
              operator: "eq",
            },
          ],
        },
      ],
    });
  }
  logger.info("Finished seeding fulfillment data.");

  // Link sales channel to stock location (idempotent - workflow handles duplicates)
  try {
    await linkSalesChannelsToStockLocationWorkflow(container).run({
      input: {
        id: stockLocation.id,
        add: [defaultSalesChannel[0].id],
      },
    });
  } catch (error: unknown) {
    // Ignore if link already exists
    if (!(error instanceof Error && error.message.includes("already"))) {
      throw error;
    }
    logger.info("Sales channel already linked to stock location, skipping.");
  }
  logger.info("Finished seeding stock location data.");

  logger.info("Seeding publishable API key data...");
  let publishableApiKey;
  const { data } = await query.graph({
    entity: "api_key",
    fields: ["id"],
    filters: {
      type: "publishable",
    },
  });

  publishableApiKey = data?.[0];

  if (!publishableApiKey) {
    const {
      result: [publishableApiKeyResult],
    } = await createApiKeysWorkflow(container).run({
      input: {
        api_keys: [
          {
            title: "Webshop",
            type: "publishable",
            created_by: "",
          },
        ],
      },
    });

    publishableApiKey = publishableApiKeyResult
  }

  // Link sales channel to API key (idempotent)
  try {
    await linkSalesChannelsToApiKeyWorkflow(container).run({
      input: {
        id: publishableApiKey.id,
        add: [defaultSalesChannel[0].id],
      },
    });
  } catch (error: unknown) {
    // Ignore if link already exists
    if (!(error instanceof Error && error.message.includes("already"))) {
      throw error;
    }
    logger.info("Sales channel already linked to API key, skipping.");
  }
  logger.info("Finished seeding publishable API key data.");

  logger.info("Seeding marketplace catalog...");

  const productModule = container.resolve(Modules.PRODUCT);

  // House seller — Mercur's store/products filter only surfaces products linked
  // to a seller whose status is "open", so the catalog needs one owner. Guarded
  // by handle (name/email/handle are unique) so re-runs are idempotent.
  const sellerService = container.resolve(MercurModules.SELLER);
  const existingSellers = await sellerService.listSellers({
    handle: HOUSE_SELLER.handle,
  });

  let houseSeller = existingSellers[0];
  if (!houseSeller) {
    const [created] = await sellerService.createSellers([
      {
        ...HOUSE_SELLER,
        currency_code: "usd",
        status: SellerStatus.OPEN,
        metadata: { house: true },
      },
    ]);
    // createSellers returns a SellerDTO (no member_invites relation); widen it
    // to the listSellers element type so the assignment type-checks (only .id is
    // used below — safe at runtime).
    houseSeller = created as (typeof existingSellers)[number];
    logger.info(`Created house seller (${houseSeller.id}).`);
  } else {
    logger.info("House seller already exists, skipping.");
  }

  // Purge the 4 default Medusa demo apparel products for a clean card catalog
  // (best-effort: they are invisible anyway with no seller link).
  const apparelProducts = await productModule.listProducts({
    handle: DEMO_APPAREL_HANDLES,
  });
  if (apparelProducts.length) {
    try {
      await deleteProductsWorkflow(container).run({
        input: { ids: apparelProducts.map((p) => p.id) },
      });
      logger.info(`Purged ${apparelProducts.length} demo apparel product(s).`);
    } catch (error: unknown) {
      logger.warn(
        `Could not purge demo apparel products: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  // Seed the 16 cards as house-seller products (guarded by handle). The
  // createProductsWorkflow `productsCreated` hook reads `additional_data.seller_id`
  // and creates the product->seller (+ inventory->seller) links automatically.
  const existingCards = await productModule.listProducts({
    handle: CARD_HANDLES,
  });
  const existingCardHandles = new Set(existingCards.map((p) => p.handle));
  const cardsToCreate = CARD_PRODUCTS.filter(
    (c) => !existingCardHandles.has(c.handle)
  );

  if (cardsToCreate.length === 0) {
    logger.info("Card products already exist, skipping.");
  } else {
    await createProductsWorkflow(container).run({
      input: {
        products: cardsToCreate.map((card) => ({
          title: card.title,
          handle: card.handle,
          status: ProductStatus.PUBLISHED,
          shipping_profile_id: shippingProfile.id,
          thumbnail: card.image,
          images: [{ url: card.image }],
          options: [{ title: "Format", values: ["Slab"] }],
          variants: [
            {
              title: "Slab",
              sku: `CARD-${card.handle.toUpperCase()}`,
              manage_inventory: true,
              options: { Format: "Slab" },
              prices: [{ currency_code: "usd", amount: card.price }],
            },
          ],
          sales_channels: [{ id: defaultSalesChannel[0].id }],
          metadata: {
            fmv: card.fmv,
            points: card.points,
            grade: card.grade,
            grader: card.grader,
            set: card.set,
            rarity: card.rarity,
            year: card.year,
          },
        })),
        additional_data: { seller_id: houseSeller.id },
      },
    });
    logger.info(`Seeded ${cardsToCreate.length} card product(s).`);
  }

  logger.info("Finished seeding marketplace catalog.");

  logger.info("Seeding inventory levels.");

  const { data: inventoryItems } = await query.graph({
    entity: "inventory_item",
    fields: ["id"],
  });

  const inventoryModule = container.resolve(Modules.INVENTORY);
  const existingLevels = await inventoryModule.listInventoryLevels({
    location_id: stockLocation.id,
  });
  const existingItemIds = new Set(existingLevels.map((l) => l.inventory_item_id));

  const inventoryLevels: CreateInventoryLevelInput[] = [];
  for (const inventoryItem of inventoryItems) {
    if (!existingItemIds.has(inventoryItem.id)) {
      const inventoryLevel = {
        location_id: stockLocation.id,
        stocked_quantity: 1000000,
        inventory_item_id: inventoryItem.id,
      };
      inventoryLevels.push(inventoryLevel);
    }
  }

  if (inventoryLevels.length > 0) {
    await createInventoryLevelsWorkflow(container).run({
      input: {
        inventory_levels: inventoryLevels,
      },
    });
  } else {
    logger.info("Inventory levels already exist, skipping.");
  }

  logger.info("Finished seeding inventory levels data.");

  // Gacha packs (Phase 4) — guarded by slug so re-runs are no-ops. Independent
  // of products/inventory: the Pack model is catalog-only this phase (the
  // pack->product checkout link + odds land in Phase 5).
  logger.info("Seeding gacha packs...");
  const packsModuleService: PacksModuleService =
    container.resolve(PACKS_MODULE);
  const existingPacks = await packsModuleService.listPacks(
    { slug: PACK_SLUGS },
    { select: ["slug"], take: PACK_SLUGS.length }
  );
  const existingPackSlugs = new Set(existingPacks.map((p) => p.slug));
  const packsToCreate = PACK_SEED.filter(
    (p) => !existingPackSlugs.has(p.slug)
  );

  if (packsToCreate.length === 0) {
    logger.info("Gacha packs already exist, skipping.");
  } else {
    // No `status` field on seed packs is intentional: Pack.status defaults to
    // "active" (the correct production state). The /store/packs[/:slug] routes
    // filter status:"active", so a future draft pack would 404 → mock fallback.
    await packsModuleService.createPacks(packsToCreate);
    logger.info(`Seeded ${packsToCreate.length} gacha pack(s).`);
  }
  logger.info("Finished seeding gacha packs.");

  // Gacha cards + odds (Phase 5a) — the prize pool + weighted table behind the
  // /claw/[slug] Top Hits and Pull Odds panels. Guarded by handle (cards) and
  // pack_id (odds) so re-runs are no-ops. The pool is the same localized graded
  // card art seeded as products in Phase 2; here it's the canonical gacha `Card`
  // record (the card->product link for inventory/checkout lands in Phase 5b).
  logger.info("Seeding gacha cards + odds...");

  // CARD_HANDLES is declared at module scope (shared with the Phase 2 card
  // products check above); reuse it rather than redeclaring.
  const existingGachaCards = await packsModuleService.listCards(
    { handle: CARD_HANDLES },
    { select: ["handle"], take: CARD_HANDLES.length }
  );
  const existingGachaCardHandles = new Set(
    existingGachaCards.map((c) => c.handle)
  );
  const gachaCardsToCreate = CARD_PRODUCTS.filter(
    (c) => !existingGachaCardHandles.has(c.handle)
  ).map((c) => ({
    handle: c.handle,
    name: c.title,
    set: c.set,
    grader: c.grader,
    grade: c.grade,
    rarity: c.rarity,
    market_value: c.fmv, // USD decimal — stored as-is, never cents.
    image: c.image,
  }));

  if (gachaCardsToCreate.length === 0) {
    logger.info("Gacha cards already exist, skipping.");
  } else {
    await packsModuleService.createCards(gachaCardsToCreate);
    logger.info(`Seeded ${gachaCardsToCreate.length} gacha card(s).`);
  }

  // Relative pull weight per rarity: pull chance = weight / Σ(weights in pack),
  // so rarer tiers carry less weight. Each pack draws ONLY from cards of its own
  // category (Phase 8 per-category pools), so a basketball pack can never pull a
  // Pokemon card. Within a category the rarity weights are identical, so the
  // aggregated per-rarity odds match across that category's packs.
  const RARITY_WEIGHT: Record<Rarity, number> = {
    Legendary: 5,
    Epic: 45,
    Rare: 150,
    Uncommon: 300,
    Common: 500,
  };

  const existingOdds = await packsModuleService.listPackOdds(
    { pack_id: PACK_SLUGS },
    // +1 headroom over the full odds-table size: if a framework page cap ever
    // truncated this read, a pack would look odds-less and get re-inserted,
    // doubling its weights and skewing the aggregated pull %.
    { select: ["pack_id"], take: PACK_SLUGS.length * CARD_HANDLES.length + 1 }
  );
  const packsWithOdds = new Set(existingOdds.map((o) => o.pack_id));
  const oddsToCreate = PACK_SEED.filter(
    (p) => !packsWithOdds.has(p.slug)
  ).flatMap((pack) => {
    // Per-category pool: a pack draws only cards whose category matches it
    // (the original 16 Pokemon cards carry no category → default "pokemon").
    const pool = CARD_PRODUCTS.filter(
      (card) => (card.category ?? "pokemon") === pack.category
    );
    if (pool.length === 0) {
      // An empty pool makes roll-pack throw (Σweight<=0) and disables the
      // pack's open button — fail loud at seed time instead of silently.
      throw new Error(
        `No gacha cards for category "${pack.category}" (pack ${pack.slug}); every active pack needs at least one card.`
      );
    }
    return pool.map((card) => ({
      pack_id: pack.slug,
      card_id: card.handle,
      weight: RARITY_WEIGHT[card.rarity] ?? 100,
    }));
  });

  if (oddsToCreate.length === 0) {
    logger.info("Gacha pack odds already exist, skipping.");
  } else {
    await packsModuleService.createPackOdds(oddsToCreate);
    logger.info(`Seeded ${oddsToCreate.length} pack-odds row(s).`);
  }
  logger.info("Finished seeding gacha cards + odds.");

  // Demo gacha activity (Phase 7) — a roster of demo collectors + a deterministic,
  // rarity-realistic spread of Pull rows so the PUBLIC leaderboard, the live
  // "Recent Pulls" feed, and the admin pull-ledger render real, populated data on
  // a fresh clone. Idempotent: guarded by the demo emails AND by whether those
  // collectors already have pulls, so re-runs never pile up more rows.
  logger.info("Seeding demo gacha activity...");
  const customerModuleService = container.resolve(Modules.CUSTOMER);

  const DEMO_COLLECTORS = [
    { first_name: "Kenji", email: "demo-collector-1@pokenic.local" },
    { first_name: "Mira", email: "demo-collector-2@pokenic.local" },
    { first_name: "Diego", email: "demo-collector-3@pokenic.local" },
    { first_name: "Anaya", email: "demo-collector-4@pokenic.local" },
    { first_name: "Leo", email: "demo-collector-5@pokenic.local" },
    { first_name: "Sora", email: "demo-collector-6@pokenic.local" },
    { first_name: "Bianca", email: "demo-collector-7@pokenic.local" },
    { first_name: "Ravi", email: "demo-collector-8@pokenic.local" },
  ];
  const demoEmails = DEMO_COLLECTORS.map((c) => c.email);
  const existingDemoCustomers = await customerModuleService.listCustomers(
    { email: demoEmails },
    { take: demoEmails.length }
  );
  const existingDemoEmails = new Set(existingDemoCustomers.map((c) => c.email));
  const demoToCreate = DEMO_COLLECTORS.filter(
    (c) => !existingDemoEmails.has(c.email)
  );
  const createdDemoCustomers = demoToCreate.length
    ? await customerModuleService.createCustomers(demoToCreate)
    : [];

  // Order by the roster (createCustomers needn't preserve input order) so the
  // descending activity assignment below is stable.
  const demoByEmail = new Map(
    [...existingDemoCustomers, ...createdDemoCustomers].map((c) => [c.email, c])
  );
  const orderedDemo = DEMO_COLLECTORS.map((d) => demoByEmail.get(d.email)).filter(
    (c): c is NonNullable<typeof c> => !!c
  );

  const demoIds = orderedDemo.map((c) => c.id);
  const existingDemoPulls = demoIds.length
    ? await packsModuleService.listPulls(
        { customer_id: demoIds },
        { select: ["id"], take: 1 }
      )
    : [];

  if (existingDemoPulls.length > 0) {
    logger.info("Demo gacha pulls already exist, skipping.");
  } else if (orderedDemo.length > 0) {
    // Rarity-realistic deterministic bag (commons frequent, legendaries rare),
    // reusing the same RARITY_WEIGHT the odds table uses.
    const BAG_SCALE = 25;
    // Per-category rarity-weighted bags so a demo pull's card matches its pack's
    // category (a pack can only yield cards of its own category — Phase 8).
    const cardBagByCategory: Record<string, string[]> = {};
    for (const c of CARD_PRODUCTS) {
      const cat = c.category ?? "pokemon";
      const n = Math.max(
        1,
        Math.round((RARITY_WEIGHT[c.rarity] ?? 100) / BAG_SCALE)
      );
      (cardBagByCategory[cat] ??= []).push(
        ...Array<string>(n).fill(c.handle)
      );
    }
    const WEEK_MIN = 7 * 24 * 60;
    const now = Date.now();
    const pullsToCreate: {
      customer_id: string;
      pack_id: string;
      card_id: string;
      order_id: null;
      rolled_at: Date;
    }[] = [];
    let counter = 0;
    orderedDemo.forEach((cust, idx) => {
      // Descending activity: rank 1 (idx 0) is the most active collector.
      const count = Math.max(2, 22 - idx * 3);
      for (let k = 0; k < count; k++) {
        const pack = PACK_SEED[(idx * 5 + k) % PACK_SEED.length];
        const bag = cardBagByCategory[pack.category] ?? [];
        if (bag.length === 0) continue; // never, every category has cards
        const card_id = bag[(counter * 7 + 3) % bag.length];
        // Spread within the last ~6 days so the weekly window includes them.
        const minutesAgo = ((counter * 53) % (WEEK_MIN - 1440)) + 30;
        pullsToCreate.push({
          customer_id: cust.id,
          pack_id: pack.slug,
          card_id,
          order_id: null,
          rolled_at: new Date(now - minutesAgo * 60 * 1000),
        });
        counter++;
      }
    });
    await packsModuleService.createPulls(pullsToCreate);
    logger.info(
      `Seeded ${pullsToCreate.length} demo pull(s) across ${orderedDemo.length} collector(s).`
    );
  }
  logger.info("Finished seeding demo gacha activity.");
}

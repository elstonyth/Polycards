/**
 * Marketplace catalog data seam.
 *
 * Single source for the marketplace listing grid + category tabs. Today it
 * returns the static cloned data; the catalog phase flips these getters to
 * `sdk.store.product.list()` / `sdk.store.productCategory.list()` without
 * touching `marketplace/page.tsx` or `MarketplaceClient.tsx` — the server page
 * already calls these getters and passes the result as props.
 *
 * Scope: marketplace only. Card-detail (`/card/[id]`) and the deferred/excluded
 * routes keep reading `@/lib/mock/*` until their own wiring phase.
 */

// Resolves a card id to its localized webp under public/cdn/cards/.
const cardImg = (id: string) => `/cdn/cards/${id.replace(/[^\w.-]/g, "_")}.webp`;

// Real card-image IDs extracted from the live site (the 8 "Recent Pulls" slabs),
// reused across the 16 marketplace listings so every image resolves locally.
const IMG = {
  celebi: "FQEYWuGiKTkJpZSG6XqGHDBmH6EmxctEqk1kAT2MYzHc",
  mewtwo: "9kRLkdbbvzm335GBvraQrWrNVs72gzEzynvP1RPvftTx",
  darkrai: "4h13RDtFX4MWNYjvgMPeBS1hcL4AewupiFzDvyFUUTkd",
  jolteon: "BEnddEeBXBHyL5qWXCg6sKS5VmUbUtZaKJ1aVB8yCWHN",
  rapidash: "FFbo5jfXHHQWN8bmc88UDYSDP5QzYCCj6RwUkiWYyffC",
  hooh: "FjAJZ7en585MpnoLUGbuALHEmbBAPd61EZCefQzFMmRX",
  gengar: "6noxMybjBLtLqicAUTrG63VhWG2FgWzDBsQGnnZEyNCG",
} as const;

export interface MarketplaceCard {
  id: string;
  title: string;
  price: number;
  fmv: number;
  points: number;
  image: string;
}

export interface MarketplaceCategory {
  name: string;
  icon: string;
}

// 16 listings. First 8 reuse the real "Recent Pulls" titles + their own images;
// the next 8 use the real marketplace listing titles/prices from the brief and
// recycle the same card-image IDs so every slab renders.
const CARDS: MarketplaceCard[] = [
  {
    id: "celebi",
    title:
      "2021 Pokemon Japanese Sword & Shield Jet-Black Spirit Celebi V #3 CGC 10 GEM MINT",
    price: 18.4,
    fmv: 19.2,
    points: 93,
    image: cardImg(IMG.celebi),
  },
  {
    id: "mewtwo",
    title:
      "2025 Pokemon Japanese SV Glory Of Rocket Gang Holo Team Rockets Mewtwo ex CGC 10",
    price: 24.75,
    fmv: 23.9,
    points: 100,
    image: cardImg(IMG.mewtwo),
  },
  {
    id: "darkrai-gg",
    title:
      "2023 Pokemon Sword and Shield Crown Zenith Galarian Gallery Darkrai Vstar #GG50 PSA 10",
    price: 41.2,
    fmv: 39.8,
    points: 100,
    image: cardImg(IMG.darkrai),
  },
  {
    id: "jolteon",
    title:
      "2024 Pokemon Japanese Scarlet & Violet Terastal Fest ex Holo Jolteon ex #52 CGC 10 PRISTINE",
    price: 15.6,
    fmv: 16.1,
    points: 96,
    image: cardImg(IMG.jolteon),
  },
  {
    id: "shaymin",
    title:
      "2022 Pokemon Japanese Sword & Shield Star Birth Holo Shaymin VSTAR #13 CGC 9.5 MINT+",
    price: 12.9,
    fmv: 13.4,
    points: 95,
    image: cardImg(IMG.celebi),
  },
  {
    id: "rapidash",
    title:
      "2025 Pokemon Japanese Mega Start Deck 100 Battle Collection Reverse Holo Rapidash #90 CGC 10",
    price: 8.45,
    fmv: 8.9,
    points: 92,
    image: cardImg(IMG.rapidash),
  },
  {
    id: "hooh",
    title:
      "2022 Pokemon Japanese Sword & Shield Incandescent Arcana Ho-Oh V #55 CGC 10 GEM MINT",
    price: 21.3,
    fmv: 20.5,
    points: 98,
    image: cardImg(IMG.hooh),
  },
  {
    id: "gengar",
    title:
      "2023 Pokemon Japanese Scarlet & Violet 151 Holo Gengar #94 CGC 10 GEM MINT",
    price: 29.99,
    fmv: 31.2,
    points: 100,
    image: cardImg(IMG.gengar),
  },
  {
    id: "espathra",
    title:
      "2023 Pokemon Scarlet & Violet Paradox Rift Reverse Holo Espathra #081 CGC 8.5 NM-MT+",
    price: 9.59,
    fmv: 9.96,
    points: 90,
    image: cardImg(IMG.gengar),
  },
  {
    id: "mimikyu",
    title:
      "2021 Pokemon Japanese SWSH VMAX Climax Mimikyu VMAX #77 CGC 8.5 NM-MT+",
    price: 9.33,
    fmv: 9.96,
    points: 92,
    image: cardImg(IMG.celebi),
  },
  {
    id: "lycanroc",
    title:
      "2016 Pokemon Japanese Sun & Moon Rockruff Full Power Deck Holo Lycanroc GX #9 CGC 5.5",
    price: 7.8,
    fmv: 8.4,
    points: 92,
    image: cardImg(IMG.rapidash),
  },
  {
    id: "garchomp",
    title:
      "2025 Pokemon Japanese Mega Dream ex Holo Cynthia's Garchomp ex #90 CGC 8.5 NM-MT+",
    price: 9.1,
    fmv: 9.5,
    points: 92,
    image: cardImg(IMG.mewtwo),
  },
  {
    id: "ribombee",
    title:
      "2025 Pokemon Scarlet & Violet Journey Together Holo Lillie's Ribombee #67 CGC 9.5 MINT",
    price: 11.2,
    fmv: 10.8,
    points: 97,
    image: cardImg(IMG.jolteon),
  },
  {
    id: "obstagoon",
    title:
      "2023 Pokemon Sword & Shield Fusion Strike K.O. Collection Galarian Obstagoon #161 CGC 9",
    price: 12.0,
    fmv: 11.5,
    points: 100,
    image: cardImg(IMG.hooh),
  },
  {
    id: "darkrai-tot",
    title:
      "2024 Pokemon Scarlet & Violet Obsidian Flames Trick Or Trade Holo Darkrai #136 CGC 9.5",
    price: 13.4,
    fmv: 12.9,
    points: 100,
    image: cardImg(IMG.darkrai),
  },
  {
    id: "dustox",
    title: "2025 Pokemon Japanese Mega Dream ex AR Dustox #195 CGC 9 MINT",
    price: 10.2,
    fmv: 9.25,
    points: 100,
    image: cardImg(IMG.celebi),
  },
];

// Category tabs match the live marketplace (icons localized to public/pack-index-icons/).
const CATEGORIES: MarketplaceCategory[] = [
  { name: "Pokémon", icon: "/pack-index-icons/pokemon.webp" },
  { name: "One Piece", icon: "/pack-index-icons/onepiece.webp" },
  { name: "Basketball", icon: "/pack-index-icons/nba.webp" },
  { name: "Football", icon: "/pack-index-icons/nfl.webp" },
  { name: "Baseball", icon: "/pack-index-icons/mlb.webp" },
  { name: "Soccer", icon: "/pack-index-icons/soccer.webp" },
  { name: "Yu-Gi-Oh!", icon: "/pack-index-icons/yugioh.webp" },
  { name: "Riftbound", icon: "/pack-index-icons/riftbound.webp" },
  { name: "Dragon Ball", icon: "/pack-index-icons/dragonball.webp" },
  { name: "Fwog", icon: "/pack-index-icons/fwog.jpg" },
  { name: "NEUKO", icon: "/pack-index-icons/neuko.jpg" },
  { name: "Vibes", icon: "/pack-index-icons/vibes.webp" },
  { name: "Moonbirds", icon: "/pack-index-icons/moonbirds.png" },
];

/** Marketplace listing grid. Flips to `sdk.store.product.list()` in the catalog phase. */
export function getMarketplaceCards(): MarketplaceCard[] {
  return CARDS;
}

/** Marketplace category tabs. Flips to `sdk.store.productCategory.list()` in the catalog phase. */
export function getMarketplaceCategories(): MarketplaceCategory[] {
  return CATEGORIES;
}

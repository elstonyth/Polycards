import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { createProductFromPriceChartingWorkflow } from '../../../../workflows/create-product-from-pricecharting';
import { optPixelPokemonId } from '../../cards/validate';
import { MAX_MARKET_VALUE_USD } from '../../../../modules/packs/sync-market-prices';
import { resolvePixelPokemonPatch } from '../../../../modules/packs/card-pixel-pokemon';
import { PACKS_MODULE } from '../../../../modules/packs';
import type PacksModuleService from '../../../../modules/packs/service';

// No `market_multiplier` field here: the per-card override still lives on the
// gacha Card (set at registration). When no explicit `price` is sent, the
// listing price defaults to FMV × FX × DEFAULT_MARKET_MULTIPLIER (+20%) — see
// the create step.
type Body = {
  pc_product_id?: unknown;
  pc_grade?: unknown;
  name?: unknown;
  set?: unknown;
  grader?: unknown;
  grade?: unknown;
  market_value?: unknown;
  image?: unknown;
  price?: unknown;
  for_sale?: unknown;
  stock?: unknown;
  // Spec 2 §5 (id-only): the pixel-Pokémon is staged by a PixelPokemon library
  // id, not a raw dex/sprite (read via optPixelPokemonId below).
  pixel_pokemon_id?: unknown;
  // Graded-slab label extras (§8), staged onto product.metadata.
  label_year?: unknown;
  label_note?: unknown;
};

const requireString = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `'${field}' is required.`,
    );
  }
  return value;
};

const requireNonNegativeNumber = (value: unknown, field: string): number => {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `'${field}' must be a non-negative number.`,
    );
  }
  return n;
};

const requireNonNegativeInteger = (value: unknown, field: string): number => {
  // Reject "" explicitly: Number("") === 0 would silently coerce a blank field to
  // 0, diverging from the admin UI's canSubmit (which requires a non-empty stock).
  if (value === '') {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `'${field}' must be provided.`,
    );
  }
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `'${field}' must be a non-negative integer.`,
    );
  }
  return n;
};

// Server backstop only — the admin UI never sends more; matches the money-cap
// posture of cards/validate.ts (plans 004/015 lineage).
const MAX_FROM_PC_STOCK = 10_000;

// Ceiling guard shared by the money/stock fields: mirrors validate.ts's
// reqMarketValue message shape so a direct API client hits the same wall.
const capAtMost = (value: number, field: string, max: number): void => {
  if (value > max) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `'${field}' must be at most ${max}.`,
    );
  }
};

const requireUrl = (value: unknown, field: string): string => {
  const s = requireString(value, field);
  let parsed: URL;
  try {
    parsed = new URL(s);
  } catch {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `'${field}' must be a valid URL.`,
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `'${field}' must use http or https.`,
    );
  }
  return s;
};

// Graded-slab label extras (§8) — same tri-state trim/cap contract as
// validate.ts's optLabelField, duplicated here because this route validates
// its own Body shape rather than going through coerceRegisterCardBody.
const optLabel = (value: unknown, field: string): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `'${field}' must be a string.`,
    );
  }
  const t = value.trim();
  if (t.length > 64) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `'${field}' is too long (max 64 chars).`,
    );
  }
  return t === '' ? null : t;
};

// POST /admin/products/from-pricecharting — mint a standalone marketplace
// Product from a PriceCharting lookup, carrying the PC link on
// product.metadata. NO card is created here.
export async function POST(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const body = req.body as Body;

  const pc_product_id = requireString(body.pc_product_id, 'pc_product_id');
  const pc_grade = requireString(body.pc_grade, 'pc_grade');
  const name = requireString(body.name, 'name');
  const market_value = requireNonNegativeNumber(
    body.market_value,
    'market_value',
  );
  // FMV drives the listing price (FMV × FX) — cap it server-side like the card
  // register/edit path caps market_value (the buyback money lever).
  capAtMost(market_value, 'market_value', MAX_MARKET_VALUE_USD);
  const image = requireUrl(body.image, 'image');

  const set = typeof body.set === 'string' ? body.set : '';
  const grader = typeof body.grader === 'string' ? body.grader : '';
  const grade = typeof body.grade === 'string' ? body.grade : '';
  const price =
    body.price === null || body.price === undefined
      ? null
      : requireNonNegativeNumber(body.price, 'price');
  // price is a USD money field on the same listing — same ceiling as FMV.
  if (price !== null) capAtMost(price, 'price', MAX_MARKET_VALUE_USD);
  const for_sale =
    typeof body.for_sale === 'boolean' ? body.for_sale : undefined;
  // Default 0: units are counted when the physical slabs are actually in hand,
  // not implied by creating the listing.
  const stock =
    body.stock === undefined
      ? 0
      : requireNonNegativeInteger(body.stock, 'stock');
  capAtMost(stock, 'stock', MAX_FROM_PC_STOCK);
  // Required (2026-07-11): a from-PC product must carry its pixel Pokémon at
  // add-time. The old "resolves from the card name" fallback fails on suffixed
  // PC names (e.g. "Blastoise ex #200") and ships a card with no reel sprite.
  // optPixelPokemonId still does the type/trim validation; null is rejected.
  const pixel_pokemon_id =
    optPixelPokemonId(body as Record<string, unknown>) ?? null;
  if (pixel_pokemon_id === null) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "'pixel_pokemon_id' is required — link a PixelPokemon library entry or upload a custom sprite.",
    );
  }
  // Resolve the id at add-time, when the library entry is guaranteed to exist.
  // The create-card step inherits this staged id and, on a bogus/deleted id,
  // deliberately degrades to name-derivation (PR #116) — reproducing the exact
  // spriteless card #135 set out to prevent. Hard-fail a bogus id here instead.
  const packs: PacksModuleService = req.scope.resolve(PACKS_MODULE);
  try {
    await resolvePixelPokemonPatch(packs, pixel_pokemon_id);
  } catch (e) {
    if (e instanceof MedusaError && e.type === MedusaError.Types.NOT_FOUND) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "'pixel_pokemon_id' does not match a PixelPokemon library entry.",
      );
    }
    throw e;
  }

  const label_year = optLabel(body.label_year, 'label_year');
  const label_note = optLabel(body.label_note, 'label_note');

  const { result } = await createProductFromPriceChartingWorkflow(
    req.scope,
  ).run({
    input: {
      pc_product_id,
      pc_grade,
      name,
      set,
      grader,
      grade,
      market_value,
      image,
      price,
      for_sale,
      stock,
      pixel_pokemon_id,
      label_year,
      label_note,
    },
  });

  res.status(201).json({ product: { id: result.id, handle: result.handle } });
}

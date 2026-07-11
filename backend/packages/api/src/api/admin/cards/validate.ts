import { MedusaError } from '@medusajs/framework/utils';
import type { RegisterCardInput } from '../../../workflows/steps/create-card';
import type { UpdateCardInput } from '../../../workflows/steps/update-card';
import { MAX_MARKET_VALUE_USD } from '../../../modules/packs/sync-market-prices';

const HANDLE_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_TEXT = 512;
const MAX_URL = 2048;
const IMAGE_RE = /^(https?:\/\/|\/)/;

const bad = (message: string): never => {
  throw new MedusaError(MedusaError.Types.INVALID_DATA, message);
};

const reqStr = (b: Record<string, unknown>, key: string): string => {
  const v = b[key];
  if (typeof v !== 'string' || v.trim() === '') bad(`'${key}' is required.`);
  const s = (b[key] as string).trim();
  if (s.length > MAX_TEXT) bad(`'${key}' is too long (max ${MAX_TEXT} chars).`);
  return s;
};

// Image: required, length-capped, restricted to http(s) URLs or storefront-
// relative paths (blocks oversized data: URIs and odd schemes).
const imageStr = (b: Record<string, unknown>, key: string): string => {
  const v = b[key];
  if (typeof v !== 'string' || v.trim() === '') bad(`'${key}' is required.`);
  const s = (b[key] as string).trim();
  if (s.length > MAX_URL) bad(`'${key}' is too long (max ${MAX_URL} chars).`);
  if (!IMAGE_RE.test(s)) {
    bad(`'${key}' must be an http(s) URL or a /storefront path.`);
  }
  return s;
};

const optStr = (b: Record<string, unknown>, key: string): string => {
  const v = b[key];
  return typeof v === 'string' ? v.trim() : '';
};

const reqNum = (b: Record<string, unknown>, key: string): number => {
  const v = typeof b[key] === 'string' ? Number(b[key]) : b[key];
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
    bad(`'${key}' must be a number >= 0.`);
  }
  return v as number;
};

// market_value is the buyback money lever — cap it like the FX seam caps rates.
const reqMarketValue = (b: Record<string, unknown>): number => {
  const v = reqNum(b, 'market_value');
  if (v > MAX_MARKET_VALUE_USD) {
    bad(`'market_value' must be at most ${MAX_MARKET_VALUE_USD}.`);
  }
  return v;
};

// Spec 2 §5 id-only picker. The admin card forms assign a Pokémon by a
// PixelPokemon library id (NOT raw dex/sprite — the backend derives those from
// the link). Tri-state, mirroring optPcId so the form can round-trip and only
// send the field when it CHANGED: undefined = picker untouched (leave the link
// as-is), null = link cleared (unlink + clear the mirror), string = an entry was
// picked (link + mirror). This is what prevents an unrelated save (e.g. a price
// edit) from wiping a linked card's sprite.
export const optPixelPokemonId = (
  b: Record<string, unknown>,
): string | null | undefined => {
  const v = b.pixel_pokemon_id;
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== 'string') bad(`'pixel_pokemon_id' must be a string.`);
  const trimmed = (v as string).trim();
  return trimmed === '' ? null : trimmed;
};

// PriceCharting linkage fields (Task 5). pc_product_id is nullable — an
// explicit null in the update body means "unlink"; undefined means "not
// provided" (create falls back to the product's metadata; update falls back
// to null via the `?? null` in update-card.ts).
const optPcId = (b: Record<string, unknown>): string | null | undefined => {
  const v = b.pc_product_id;
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== 'string') bad(`'pc_product_id' must be a string.`);
  const trimmed = (v as string).trim();
  return trimmed === '' ? null : trimmed;
};

const optPcGrade = (b: Record<string, unknown>): string | null | undefined => {
  const v = b.pc_grade;
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== 'string') bad(`'pc_grade' must be a string.`);
  const trimmed = (v as string).trim();
  return trimmed === '' ? null : trimmed;
};

// The PriceCharting sync needs BOTH fields together (pc_product_id to fetch,
// pc_grade to pick the price field) — half-linked (one set, other null) is
// rejected. Fully-linked (both set) and unlink (both null/absent) are fine.
const checkPcPairing = (
  pcProductId: string | null | undefined,
  pcGrade: string | null | undefined,
): void => {
  const idSet = pcProductId != null;
  const gradeSet = pcGrade != null;
  if (idSet !== gradeSet) {
    bad(
      "'pc_product_id' and 'pc_grade' must both be set or both be null/omitted.",
    );
  }
};

// Multiplier ceiling: the client caps display margin at 1000%, and both card
// forms store `1 + pct/100` — so 1000% maps to exactly 11. Bounding here (not
// just client-side) stops any caller from smuggling an absurd price multiplier
// past the edit path's UI guard.
const MAX_MARKET_MULTIPLIER = 11;

const optMultiplier = (b: Record<string, unknown>): number | undefined => {
  const v = b.market_multiplier;
  if (v === undefined || v === null || v === '') return undefined;
  const n = typeof v === 'string' ? Number(v) : v;
  if (
    typeof n !== 'number' ||
    !Number.isFinite(n) ||
    n <= 0 ||
    n > MAX_MARKET_MULTIPLIER
  ) {
    bad(
      `'market_multiplier' must be greater than 0 and at most ${MAX_MARKET_MULTIPLIER}.`,
    );
  }
  return n as number;
};

const asObject = (raw: unknown): Record<string, unknown> => {
  if (!raw || typeof raw !== 'object') {
    bad('Body must be an object.');
  }
  return raw as Record<string, unknown>;
};

// Coerce + validate the registration body (inventory-first create): the product
// is referenced by id; only the gacha facts are entered. Rarity is per-pack and
// is NOT part of a card.
export function coerceRegisterCardBody(raw: unknown): RegisterCardInput {
  const b = asObject(raw);

  const pc_product_id = optPcId(b);
  const pc_grade = optPcGrade(b);
  checkPcPairing(pc_product_id, pc_grade);

  return {
    product_id: reqStr(b, 'product_id'),
    set: optStr(b, 'set'),
    grader: optStr(b, 'grader'),
    grade: optStr(b, 'grade'),
    market_value: reqMarketValue(b),
    pixel_pokemon_id: optPixelPokemonId(b),
    pc_product_id,
    pc_grade,
    market_multiplier: optMultiplier(b),
  };
}

// Coerce + validate the card edit body. `handle` comes from the route params
// (immutable — it keys PackOdds/Pull/Product).
export function coerceUpdateCardBody(
  raw: unknown,
  handle: string,
): UpdateCardInput {
  const b = asObject(raw);

  if (!HANDLE_RE.test(handle)) {
    bad("'handle' must be lowercase kebab-case (letters, digits, hyphens).");
  }

  const priceRaw = b.price;
  const price =
    priceRaw === undefined || priceRaw === null || priceRaw === ''
      ? undefined
      : reqNum(b, 'price');

  const pc_product_id = optPcId(b);
  const pc_grade = optPcGrade(b);
  checkPcPairing(pc_product_id, pc_grade);

  return {
    handle,
    name: reqStr(b, 'name'),
    set: optStr(b, 'set'),
    grader: optStr(b, 'grader'),
    grade: optStr(b, 'grade'),
    market_value: reqMarketValue(b),
    image: imageStr(b, 'image'),
    price,
    for_sale: b.for_sale !== false, // default true unless explicitly false
    pixel_pokemon_id: optPixelPokemonId(b),
    pc_product_id,
    pc_grade,
    market_multiplier: optMultiplier(b),
  };
}

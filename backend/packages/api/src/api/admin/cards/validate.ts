import { MedusaError } from "@medusajs/framework/utils";
import type { CardWriteInput, Rarity } from "../../../workflows/steps/create-card";

const RARITIES: Rarity[] = [
  "Legendary",
  "Epic",
  "Rare",
  "Uncommon",
  "Common",
];

const HANDLE_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_TEXT = 512;
const MAX_URL = 2048;
const IMAGE_RE = /^(https?:\/\/|\/)/;

const bad = (message: string): never => {
  throw new MedusaError(MedusaError.Types.INVALID_DATA, message);
};

const reqStr = (b: Record<string, unknown>, key: string): string => {
  const v = b[key];
  if (typeof v !== "string" || v.trim() === "") bad(`'${key}' is required.`);
  const s = (b[key] as string).trim();
  if (s.length > MAX_TEXT) bad(`'${key}' is too long (max ${MAX_TEXT} chars).`);
  return s;
};

// Image: required, length-capped, restricted to http(s) URLs or storefront-
// relative paths (blocks oversized data: URIs and odd schemes).
const imageStr = (b: Record<string, unknown>, key: string): string => {
  const v = b[key];
  if (typeof v !== "string" || v.trim() === "") bad(`'${key}' is required.`);
  const s = (b[key] as string).trim();
  if (s.length > MAX_URL) bad(`'${key}' is too long (max ${MAX_URL} chars).`);
  if (!IMAGE_RE.test(s)) {
    bad(`'${key}' must be an http(s) URL or a /storefront path.`);
  }
  return s;
};

const optStr = (b: Record<string, unknown>, key: string): string => {
  const v = b[key];
  return typeof v === "string" ? v.trim() : "";
};

const reqNum = (b: Record<string, unknown>, key: string): number => {
  const v = typeof b[key] === "string" ? Number(b[key]) : b[key];
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
    bad(`'${key}' must be a number >= 0.`);
  }
  return v as number;
};

// Coerce + validate the card form body into a CardWriteInput. `handle` comes from
// the route params on update (immutable) and from the body on create.
export function coerceCardBody(
  raw: unknown,
  handle: string
): CardWriteInput {
  if (!raw || typeof raw !== "object") {
    bad("Body must be an object.");
  }
  const b = raw as Record<string, unknown>;

  if (!HANDLE_RE.test(handle)) {
    bad("'handle' must be lowercase kebab-case (letters, digits, hyphens).");
  }

  const rarity = reqStr(b, "rarity") as Rarity;
  if (!RARITIES.includes(rarity)) {
    bad(`'rarity' must be one of: ${RARITIES.join(", ")}.`);
  }

  const priceRaw = b.price;
  const price =
    priceRaw === undefined || priceRaw === null || priceRaw === ""
      ? undefined
      : reqNum(b, "price");

  return {
    handle,
    name: reqStr(b, "name"),
    set: optStr(b, "set"),
    grader: optStr(b, "grader"),
    grade: optStr(b, "grade"),
    rarity,
    market_value: reqNum(b, "market_value"),
    image: imageStr(b, "image"),
    price,
    for_sale: b.for_sale !== false, // default true unless explicitly false
  };
}

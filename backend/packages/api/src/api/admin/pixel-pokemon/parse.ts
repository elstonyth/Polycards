// Body parsing for POST /admin/pixel-pokemon, pure so the unit suite drives it.
//
// One library, separate decks: a sprite's `franchise` matches a pack category.
// Pokémon are numbered by `dex` (grouping only, 1–1025); every other franchise
// by `number` (One Piece #001…). The two never cross — a One Piece row with a
// dex would be mirrored onto cards as a Pokémon and render that Pokémon.

export const SPRITE_FRANCHISES = ['pokemon', 'one-piece'] as const;
export type SpriteFranchise = (typeof SPRITE_FRANCHISES)[number];

export type PixelPokemonInput = {
  name: string;
  franchise: SpriteFranchise;
  dex: number | null;
  number: number | null;
  variant: string;
  types: string[];
  image_url: string;
  image_key: string | null;
};

const blank = (v: unknown) => v === undefined || v === null || v === '';

export function parsePixelPokemonBody(
  b: Record<string, unknown>,
): { ok: true; value: PixelPokemonInput } | { ok: false; message: string } {
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name) return { ok: false, message: "'name' is required." };

  const image_url = typeof b.image_url === 'string' ? b.image_url.trim() : '';
  // http(s):// or a single root-relative path — reject javascript:/data: (XSS in
  // the <img src> render) AND protocol-relative "//host" / "/\\host" (which would
  // load an arbitrary external host). Normal uploads return our own media URL.
  if (!image_url || !/^(https?:\/\/|\/(?![/\\]))/.test(image_url)) {
    return {
      ok: false,
      message: "'image_url' must be an uploaded sprite URL.",
    };
  }

  const franchise = blank(b.franchise) ? 'pokemon' : b.franchise;
  if (!SPRITE_FRANCHISES.includes(franchise as SpriteFranchise)) {
    return {
      ok: false,
      message: `'franchise' must be one of: ${SPRITE_FRANCHISES.join(', ')}.`,
    };
  }

  let dex: number | null = null;
  if (!blank(b.dex)) {
    if (franchise !== 'pokemon') {
      return {
        ok: false,
        message: `A ${franchise} sprite has no dex — use 'number'.`,
      };
    }
    const n = Number(b.dex);
    if (!Number.isInteger(n) || n < 1 || n > 1025) {
      return {
        ok: false,
        message: "'dex' must be an integer 1–1025, or left blank.",
      };
    }
    dex = n;
  }

  let number: number | null = null;
  if (!blank(b.number)) {
    if (franchise === 'pokemon') {
      return {
        ok: false,
        message: "Pokémon sprites are numbered by 'dex', not 'number'.",
      };
    }
    const n = Number(b.number);
    if (!Number.isInteger(n) || n < 1 || n > 99999) {
      return {
        ok: false,
        message: "'number' must be an integer 1–99999, or left blank.",
      };
    }
    number = n;
  }

  const variant =
    (typeof b.variant === 'string' && b.variant.trim()) || 'custom';
  const types = Array.isArray(b.types)
    ? (b.types as unknown[])
        .filter((t): t is string => typeof t === 'string')
        .map((t) => t.trim())
        .filter(Boolean)
    : [];
  const image_key =
    typeof b.image_key === 'string' && b.image_key.trim()
      ? b.image_key.trim()
      : null;

  return {
    ok: true,
    value: {
      name,
      franchise: franchise as SpriteFranchise,
      dex,
      number,
      variant,
      types,
      image_url,
      image_key,
    },
  };
}

/** "dex 25" / "one-piece #1" — for the duplicate-entry message. */
export const entryLabel = (
  v: Pick<PixelPokemonInput, 'franchise' | 'dex' | 'number'>,
) =>
  v.franchise === 'pokemon' ? `dex ${v.dex}` : `${v.franchise} #${v.number}`;

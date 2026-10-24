import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { PACKS_MODULE } from '../../../modules/packs';
import type PacksModuleService from '../../../modules/packs/service';
import { asPixelPokemonCrud } from '../../../modules/packs/pixel-pokemon-service';
import { entryLabel, parsePixelPokemonBody } from './parse';

// GET /admin/pixel-pokemon — the Pokédex library list for the admin dashboard.
// Returns every seeded/custom pixel-pokémon. Filters (q = name or number — dex
// for Pokémon, `number` for other franchises — franchise, type, variant,
// custom) + pagination are applied server-side over the (≤ a couple
// thousand) rows, so a single ordered list query backs the whole page. The
// route is auto-protected by Medusa admin auth. Uses asPixelPokemonCrud because
// the pixel_pokemon runtime methods are singular ("pokemon" is uncountable).

type Row = {
  id: string;
  name: string;
  dex: number | null;
  franchise: string;
  number: number | null;
  variant: string;
  types: unknown;
  image_url: string | null;
  is_custom: boolean;
};

const asTypes = (t: unknown): string[] =>
  Array.isArray(t) ? (t as string[]) : [];

export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const pixels = asPixelPokemonCrud(packs);

  const q = String(req.query.q ?? '')
    .trim()
    .toLowerCase();
  const typeF = String(req.query.type ?? '')
    .trim()
    .toLowerCase();
  const franchiseF = String(req.query.franchise ?? '')
    .trim()
    .toLowerCase();
  const variantF = String(req.query.variant ?? '')
    .trim()
    .toLowerCase();
  const customF = req.query.custom; // 'true' | 'false' | undefined
  const limit = Math.min(Math.max(Number(req.query.limit ?? 60) || 60, 1), 200);
  const offset = Math.max(Number(req.query.offset ?? 0) || 0, 0);

  // Fetch the WHOLE library, paged — never cap. A fixed `take` would drop rows
  // past it, and since NULL-dex customs sort last under `dex ASC`, those custom
  // rows (the ones this page exists to manage) would be the first casualties —
  // silently corrupting total / all_types / the custom-only filter. (CodeRabbit)
  const all: Row[] = [];
  const PAGE = 1000;
  for (let skip = 0; ; skip += PAGE) {
    const batch = (await pixels.listPixelPokemon(
      {},
      // `id` breaks dex ties so a row can't straddle two pages (shown twice,
      // or never) — variants and custom uploads share a dex.
      { skip, take: PAGE, order: { dex: 'ASC', id: 'ASC' } },
    )) as unknown as Row[];
    all.push(...batch);
    if (batch.length < PAGE) break;
  }

  const numQ = /^\d+$/.test(q) ? Number(q) : null;
  // Each deck's own number: a Pokémon's dex, a One Piece character's number.
  const numberOf = (p: Row) => (p.franchise === 'pokemon' ? p.dex : p.number);
  const filtered = all.filter((p) => {
    const types = asTypes(p.types);
    if (franchiseF && p.franchise !== franchiseF) return false;
    if (
      q &&
      !(
        p.name.toLowerCase().includes(q) ||
        (numQ !== null && numberOf(p) === numQ)
      )
    )
      return false;
    if (typeF && !types.some((t) => t.toLowerCase() === typeF)) return false;
    if (variantF && p.variant.toLowerCase() !== variantF) return false;
    if (customF === 'true' && !p.is_custom) return false;
    if (customF === 'false' && p.is_custom) return false;
    return true;
  });
  // The list query orders by dex, which a non-Pokémon deck doesn't have: order
  // it by its own number (#001 → …), unnumbered entries last.
  if (franchiseF && franchiseF !== 'pokemon') {
    filtered.sort(
      (a, b) =>
        (a.number ?? Infinity) - (b.number ?? Infinity) ||
        a.name.localeCompare(b.name),
    );
  }

  // Distinct types across the whole library — powers the filter chips.
  const typeSet = new Set<string>();
  for (const p of all) for (const t of asTypes(p.types)) typeSet.add(t);

  res.json({
    pixel_pokemon: filtered
      .slice(offset, offset + limit)
      .map((p) => ({ ...p, types: asTypes(p.types) })),
    total: filtered.length,
    limit,
    offset,
    all_types: [...typeSet].sort(),
  });
}

// POST /admin/pixel-pokemon — add a custom pixel-pokémon to the library. The
// sprite is uploaded separately via POST /admin/media; the returned URL comes
// in as image_url. `franchise` (default 'pokemon') picks the deck: Pokémon
// take an optional `dex`, other franchises an optional `number` — never the
// other way round (see ./parse.ts). `variant` defaults to 'custom' so it never
// collides with a base 'normal' row (the partial unique indexes only constrain
// variant='normal'). is_custom is forced true.
export async function POST(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const pixels = asPixelPokemonCrud(packs);
  const parsed = parsePixelPokemonBody(
    (req.body ?? {}) as Record<string, unknown>,
  );
  if (!parsed.ok) {
    res.status(400).json({ message: parsed.message });
    return;
  }
  const v = parsed.value;

  try {
    const [created] = await pixels.createPixelPokemon([
      {
        name: v.name,
        franchise: v.franchise,
        dex: v.dex,
        number: v.number,
        variant: v.variant,
        types: v.types as unknown as Record<string, unknown>,
        image_url: v.image_url,
        image_key: v.image_key,
        is_custom: true,
      },
    ]);
    res.status(201).json({ pixel_pokemon: created });
  } catch (e) {
    // Partial unique indexes — (dex) for Pokémon, (franchise, number) for the
    // rest — among 'normal' rows: a second base sprite for the same character.
    // (Medusa's db-error mapper normally answers this itself with a 400 "Pixel
    // pokemon with franchise: one-piece, number: 1, already exists."; the raw
    // pg code is the fallback for paths that skip that mapper.)
    if ((e as { code?: string })?.code === '23505') {
      res.status(400).json({
        message: `A '${v.variant}' entry for ${entryLabel(v)} already exists.`,
      });
      return;
    }
    throw e;
  }
}

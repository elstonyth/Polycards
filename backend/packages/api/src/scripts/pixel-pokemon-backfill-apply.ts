import { ExecArgs } from '@medusajs/framework/types';
import { ContainerRegistrationKeys } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../modules/packs';
import type PacksModuleService from '../modules/packs/service';
import { asPixelPokemonCrud } from '../modules/packs/pixel-pokemon-service';
import { applyRow, type ReviewRow } from './pixel-pokemon-backfill.helpers';
import fs from 'fs';
import path from 'path';

// pixel-pokemon-backfill-apply — link each reviewed card to its seeded "normal"
// PixelPokemon by id AND mirror the entry's image_url/dex onto the card's
// sprite_image/pokemon_dex (Spec 2 §3 phase 3 + §4). Reads the human-corrected
// pixel-pokemon-backfill.json. Idempotent: re-running writes the same links.
// This is the step that kills the evolved-switching bug (a corrected row links
// to the RIGHT species) and the not-loaded bug (sprite_image = CDN url).
//
// Run: ./node_modules/.bin/medusa exec ./src/scripts/pixel-pokemon-backfill-apply.ts

const IN = path.resolve(process.cwd(), 'pixel-pokemon-backfill.json');

export default async function apply({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
  const pixels = asPixelPokemonCrud(packs);

  if (!fs.existsSync(IN)) {
    logger.error(
      `backfill-apply: ${IN} not found — run pixel-pokemon-backfill-propose.ts first.`,
    );
    return;
  }
  let rows: ReviewRow[];
  try {
    rows = JSON.parse(fs.readFileSync(IN, 'utf8')) as ReviewRow[];
  } catch (err) {
    logger.error(
      `backfill-apply: could not parse ${IN} (corrupted or mis-edited?) — ${(err as Error).message}`,
    );
    return;
  }

  // Index the seeded "normal" entries by dex (one query, not one-per-card).
  const normals = await pixels.listPixelPokemon(
    { variant: 'normal' },
    { take: 5000 },
  );
  const pixelByDex = new Map<
    number,
    { id: string; dex: number | null; image_url: string | null }
  >();
  for (const p of normals) {
    if (typeof p.dex === 'number') {
      pixelByDex.set(p.dex, {
        id: p.id,
        dex: p.dex,
        image_url: p.image_url ?? null,
      });
    }
  }

  let linked = 0;
  let skipped = 0;
  for (const row of rows) {
    const patch = applyRow(row, pixelByDex);
    if (!patch) {
      skipped++;
      continue;
    }
    await packs.updateCards([
      {
        id: patch.id,
        pixel_pokemon_id: patch.pixel_pokemon_id,
        pokemon_dex: patch.pokemon_dex,
        sprite_image: patch.sprite_image,
      },
    ]);
    linked++;
  }

  logger.info(
    `backfill-apply: linked ${linked} card(s), skipped ${skipped} (no chosen dex / no seeded entry).`,
  );
}

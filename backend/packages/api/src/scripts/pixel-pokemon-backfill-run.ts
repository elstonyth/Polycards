import { ExecArgs } from '@medusajs/framework/types';
import { ContainerRegistrationKeys } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../modules/packs';
import type PacksModuleService from '../modules/packs/service';
import { asPixelPokemonCrud } from '../modules/packs/pixel-pokemon-service';
import { proposeRow, applyRow } from './pixel-pokemon-backfill.helpers';

// pixel-pokemon-backfill-run — propose + apply in ONE process (no review file,
// no shell `&&`). This exists because DO App Platform runs a job's `run_command`
// WITHOUT a shell (argv-split), so `medusa exec propose && medusa exec apply`
// silently runs only propose. A single `medusa exec` of this script chains the
// two in-process instead.
//
// SAFETY: AMBIGUOUS rows (a card name that matches ≥2 species, e.g. an
// evolution-collision like Rockruff → Lycanroc 744/745) are LEFT UNLINKED here —
// they need a human to pick the right dex, which this non-interactive path
// cannot do. For a card set with real collisions, use the file-based
// propose → (human edits chosen_dex) → apply flow instead. Unambiguous rows
// (exactly one match) link + mirror. Idempotent: re-running writes the same links.
//
// Run: ./node_modules/.bin/medusa exec ./src/scripts/pixel-pokemon-backfill-run.ts

export default async function backfillRun({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
  const pixels = asPixelPokemonCrud(packs);

  // All cards, paged — never silently truncate (mirrors propose).
  const cards: { id: string; name: string }[] = [];
  const PAGE = 1000;
  for (let skip = 0; ; skip += PAGE) {
    const batch = await packs.listCards({}, { skip, take: PAGE });
    for (const c of batch) cards.push({ id: c.id, name: c.name });
    if (batch.length < PAGE) break;
  }
  const rows = cards.map((c) => proposeRow(c));

  // Seeded "normal" entries indexed by dex (≤1 per dex via the partial unique index).
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
  let ambiguousSkipped = 0;
  let noMatch = 0;
  for (const row of rows) {
    // Never auto-link an ambiguous card — a human must pick the species.
    if (row.ambiguous) {
      ambiguousSkipped++;
      logger.warn(
        `backfill-run: '${row.card_name}' is AMBIGUOUS (${row.all_matches
          .map((m) => `${m.dex}:${m.name}`)
          .join(', ')}) — left UNLINKED; use the file-based flow to resolve it.`,
      );
      continue;
    }
    const patch = applyRow(row, pixelByDex);
    if (!patch) {
      noMatch++;
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
    `backfill-run: ${cards.length} cards — linked ${linked}, ambiguous-skipped ${ambiguousSkipped}, no-match/no-seed ${noMatch}.`,
  );
}

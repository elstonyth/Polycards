import { ExecArgs } from '@medusajs/framework/types';
import { ContainerRegistrationKeys } from '@medusajs/framework/utils';
import { uploadFilesWorkflow } from '@medusajs/medusa/core-flows';
import { POKEDEX_NAMES } from '@acme/pokemon';
import { PACKS_MODULE } from '../modules/packs';
import type PacksModuleService from '../modules/packs/service';
import {
  chooseSpriteUrl,
  extractTypes,
  spriteExt,
  type PokeApiPokemon,
} from './pixel-pokemon-seed.helpers';

// seed-pixel-pokemon — host one "normal" sprite per national dex on Spaces and
// upsert a PixelPokemon row (Spec 2 §2). ONE PokeAPI call per dex yields types +
// sprite url. Idempotent on (dex, 'normal'); throttled; re-runnable (also
// backfills an image_url that was null when PokeAPI first lacked a sprite).
//
// Run (needs Spaces/S3 creds in env): ./node_modules/.bin/medusa exec ./src/scripts/seed-pixel-pokemon.ts
//
// ponytail: a re-run that replaces an existing sprite leaks the old Spaces file
// (no delete of the prior image_key). Fine — the seed rarely re-runs; add a
// delete-old-key step here if that ever matters.

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

export default async function seedPixelPokemon({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
  const total = POKEDEX_NAMES.length; // 1025 — tracks the dex list, not a literal
  let created = 0;
  let updated = 0;
  let noSprite = 0;
  let failed = 0;

  for (let dex = 1; dex <= total; dex++) {
    const name = POKEDEX_NAMES[dex - 1];
    try {
      const res = await fetch(`https://pokeapi.co/api/v2/pokemon/${dex}`);
      if (!res.ok) {
        failed++;
        logger.warn(`dex ${dex} (${name}): pokeapi ${res.status}`);
        await sleep(120);
        continue;
      }
      const poke = (await res.json()) as PokeApiPokemon;
      const types = extractTypes(poke);
      const spriteUrl = chooseSpriteUrl(poke);

      let image_url: string | null = null;
      let image_key: string | null = null;
      if (spriteUrl) {
        const buf = Buffer.from(await (await fetch(spriteUrl)).arrayBuffer());
        const ext = spriteExt(spriteUrl);
        const { result } = await uploadFilesWorkflow(container).run({
          input: {
            files: [
              {
                filename: `pixel-pokemon-${dex}-normal.${ext}`,
                mimeType: ext === 'gif' ? 'image/gif' : 'image/png',
                content: buf.toString('base64'),
                access: 'public',
              },
            ],
          },
        });
        image_url = result?.[0]?.url ?? null;
        image_key = result?.[0]?.id ?? null;
      }
      if (!image_url) noSprite++;

      const [existing] = await packs.listPixelPokemons(
        { dex, variant: 'normal' },
        { take: 1 },
      );
      // ponytail: PixelPokemon.types is model.json(), so the generated create/update
      // input types it as Record<string, unknown> — arrays have no string index
      // signature, so a plain string[] doesn't structurally match. Same double-cast
      // update-pack.ts already uses for its json column; the DB just stores the array.
      const typesJson = types as unknown as Record<string, unknown>;
      if (existing) {
        await packs.updatePixelPokemons([
          {
            id: existing.id,
            name,
            types: typesJson,
            image_url,
            image_key,
            is_custom: false,
          },
        ]);
        updated++;
      } else {
        await packs.createPixelPokemons([
          {
            name,
            dex,
            variant: 'normal',
            types: typesJson,
            image_url,
            image_key,
            is_custom: false,
          },
        ]);
        created++;
      }
    } catch (e) {
      failed++;
      logger.warn(`dex ${dex} (${name}) failed: ${(e as Error).message}`);
    }
    await sleep(120); // throttle PokeAPI — be a good citizen (one-time cost)
  }

  logger.info(
    `seed-pixel-pokemon: ${created} created, ${updated} updated, ${noSprite} without sprite, ${failed} failed (of ${total}).`,
  );
}

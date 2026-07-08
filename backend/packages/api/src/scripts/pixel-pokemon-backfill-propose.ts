import { ExecArgs } from '@medusajs/framework/types';
import { ContainerRegistrationKeys } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../modules/packs';
import type PacksModuleService from '../modules/packs/service';
import { proposeRow, type ReviewRow } from './pixel-pokemon-backfill.helpers';
import fs from 'fs';
import path from 'path';

// pixel-pokemon-backfill-propose — emit the human-review file (Spec 2 §3 phase 1).
// Does NOT write to the DB. Review `pixel-pokemon-backfill.json`, correct
// `chosen_dex` on every `ambiguous`/wrong row (e.g. Rockruff → 745 Lycanroc),
// then run pixel-pokemon-backfill-apply.ts.
//
// Run: ./node_modules/.bin/medusa exec ./src/scripts/pixel-pokemon-backfill-propose.ts

const OUT = path.resolve(process.cwd(), 'pixel-pokemon-backfill.json');

export default async function propose({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const packs = container.resolve<PacksModuleService>(PACKS_MODULE);

  const cards = await packs.listCards({}, { take: 5000 });
  const rows: ReviewRow[] = cards.map((c) =>
    proposeRow({ id: c.id, name: c.name }),
  );
  fs.writeFileSync(OUT, JSON.stringify(rows, null, 2));

  const ambiguous = rows.filter((r) => r.ambiguous).length;
  const unresolved = rows.filter((r) => r.chosen_dex == null).length;
  logger.info(
    `backfill-propose: wrote ${rows.length} rows to ${OUT} — ${ambiguous} ambiguous (edit chosen_dex), ${unresolved} with no species (stay unlinked).`,
  );
}

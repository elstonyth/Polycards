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

  // Fetch ALL cards, paged — never silently truncate the review set (a fixed
  // `take` cap would drop cards past it, leaving them unlinked; 2 reviewers).
  const cards: { id: string; name: string }[] = [];
  const PAGE = 1000;
  for (let skip = 0; ; skip += PAGE) {
    const batch = await packs.listCards({}, { skip, take: PAGE });
    for (const c of batch) cards.push({ id: c.id, name: c.name });
    if (batch.length < PAGE) break;
  }
  const rows: ReviewRow[] = cards.map((c) => proposeRow(c));
  fs.writeFileSync(OUT, JSON.stringify(rows, null, 2));

  const ambiguous = rows.filter((r) => r.ambiguous).length;
  const unresolved = rows.filter((r) => r.chosen_dex == null).length;
  logger.info(
    `backfill-propose: wrote ${rows.length} rows to ${OUT} — ${ambiguous} ambiguous (edit chosen_dex), ${unresolved} with no species (stay unlinked).`,
  );
}

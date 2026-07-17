import { ExecArgs } from '@medusajs/framework/types';
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils';
import { updateProductsWorkflow } from '@medusajs/medusa/core-flows';
import { PACKS_MODULE } from '../modules/packs';
import type PacksModuleService from '../modules/packs/service';
import { resolvePcImageUrl } from '../api/admin/pricecharting/product-image';
import { ingestPcImage } from '../api/admin/media/ingest-pc-image';
import { pcFetch } from '../api/admin/pricecharting/client';
import {
  bakeSlabImage,
  deleteSlabFile,
  mirrorSlabToProduct,
  resolveFrameBytes,
} from '../api/admin/media/bake-slab';

// repull-pc-images — replace EVERY catalog image with a freshly ingested copy
// of its PriceCharting product photo, through the SAME seam "Add from
// PriceCharting" uses (photo scrape → validated media ingest → our own stored
// copy, never a hotlink).
//
// Coverage, in order:
//   1. ALL Medusa products: pc id from metadata.pc_product_id, else found via
//      the PriceCharting search API using the product title (grade suffix
//      stripped — PC names carry no grade). A search hit is written back to
//      metadata.pc_product_id so the next run resolves directly. Updates
//      product thumbnail + images, and the same-handle gacha Card when one
//      exists.
//   2. Gacha cards with a pc_product_id whose handle had no product above.
//
// A row whose photo can't be matched/resolved/ingested KEEPS its current
// image and is listed at the end (the log shows the searched-for title next
// to the matched PC name — audit it for mismatches). Sequential on purpose
// (polite to PC); repeated pc_product_ids ingest once. Idempotent, safe to
// re-run.
//
// Needs PRICECHARTING_API_TOKEN in the backend .env for the search fallback;
// metadata-linked rows work without it. Unlinked products are SKIPPED by
// default (an operator confirms the search match) — pass --link-first-hit to
// auto-link to the top search result as before.
//
// ponytail: replaced files are orphaned in static//Spaces; add a deleteFiles
// sweep when storage cost matters.
//
// Run:  corepack yarn medusa exec ./src/scripts/repull-pc-images.ts
//       … ./src/scripts/repull-pc-images.ts --only <product-or-card-handle>
//       … ./src/scripts/repull-pc-images.ts --link-first-hit

type PcSearchResponse = {
  status: string;
  'error-message'?: string;
  products?: Array<{
    id: string | number;
    'product-name'?: string;
    'console-name'?: string;
  }>;
};

// "… Holo Espathra #081 CGC 8.5 NM-MT+" → "… Holo Espathra #081"
const searchQuery = (title: string): string =>
  title.replace(/\s+(PSA|CGC|BGS|SGC|TAG|ACE)\s.*$/i, '').trim();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default async function repullPcImages({ container, args }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
  const productModule = container.resolve(Modules.PRODUCT);

  const onlyIdx = args?.indexOf('--only') ?? -1;
  const only = onlyIdx >= 0 ? args?.[onlyIdx + 1] : undefined;
  const linkFirstHit = process.argv.includes('--link-first-hit');

  // pc_product_id → stored URL (grades of one card share a PC product).
  const storedByPcId = new Map<string, string>();
  const resolveStored = async (pcId: string): Promise<string> => {
    let stored = storedByPcId.get(pcId);
    if (!stored) {
      const pcUrl = await resolvePcImageUrl(pcId);
      if (!pcUrl) {
        throw new Error('no photo found on the PriceCharting offers page');
      }
      stored = await ingestPcImage(container, pcUrl);
      storedByPcId.set(pcId, stored);
    }
    return stored;
  };

  const searchPcId = async (
    title: string,
  ): Promise<{ id: string; matched: string } | null> => {
    const q = searchQuery(title);
    const result = await pcFetch<PcSearchResponse>('/api/products', { q });
    if (result.kind === 'no-token') {
      throw new Error(
        'PRICECHARTING_API_TOKEN missing — cannot search unlinked products',
      );
    }
    if (result.kind === 'error') throw new Error(result.message);
    const first = result.data.products?.[0];
    if (!first) return null;
    return {
      id: String(first.id),
      matched:
        `${first['console-name'] ?? ''} ${first['product-name'] ?? ''}`.trim(),
    };
  };

  // Page through everything — a fixed take would silently skip catalog
  // entries once the dataset outgrows it.
  const listAll = async <T>(
    page: (skip: number, take: number) => Promise<T[]>,
  ): Promise<T[]> => {
    const TAKE = 200;
    const out: T[] = [];
    for (let skip = 0; ; skip += TAKE) {
      const batch = await page(skip, TAKE);
      out.push(...batch);
      if (batch.length < TAKE) return out;
    }
  };

  const allCards = await listAll((skip, take) =>
    packs.listCards({}, { skip, take }),
  );
  const cardByHandle = new Map(allCards.map((c) => [c.handle, c]));

  let replaced = 0;
  const kept: string[] = [];

  // Re-pull ⇒ re-bake (spec §C): a replaced photo invalidates the graded
  // card's baked composite. Best-effort — a failed bake leaves nulls (bare
  // photo) and the backfill script can retry later.
  // The frame is resolved once per run (lazily, on the first graded card) and
  // shared across all re-bakes — same rationale as rebakeAllGradedCards: a
  // mid-run frame-fetch failure must not mix bundled-default and real-frame
  // composites within one run.
  let frameBytes: Buffer | null = null;
  const rebakeCard = async (
    card: {
      id: string;
      handle: string;
      grader: string;
      grade: string;
      name: string;
      set: string;
      label_year?: string | null;
      label_note?: string | null;
      slab_image_key?: string | null;
    },
    stored: string,
  ) => {
    if (card.grader.trim() === '') return;
    frameBytes ??= await resolveFrameBytes(container);
    const baked = await bakeSlabImage(
      container,
      {
        handle: card.handle,
        image: stored,
        grader: card.grader,
        grade: card.grade,
        name: card.name,
        set: card.set,
        label_year: card.label_year ?? null,
        label_note: card.label_note ?? null,
      },
      frameBytes,
    );
    const oldKey = card.slab_image_key ?? null;
    await packs.updateCards([
      {
        id: card.id,
        slab_image: baked?.url ?? null,
        slab_image_key: baked?.key ?? null,
      },
    ]);
    await mirrorSlabToProduct(container, card.handle, baked?.url ?? null);
    if (oldKey && oldKey !== (baked?.key ?? null)) {
      await deleteSlabFile(container, oldKey);
    }
  };

  // ---- 1. The whole marketplace catalog -----------------------------------
  const products = await listAll((skip, take) =>
    productModule.listProducts(only ? { handle: only } : {}, { skip, take }),
  );
  logger.info(
    `repull-pc-images: ${products.length} product(s)${only ? ` (--only ${only})` : ''}, ${allCards.length} gacha card(s).`,
  );

  const doneHandles = new Set<string>();
  for (const product of products) {
    const label = product.handle ?? product.id;
    try {
      let pcId =
        typeof product.metadata?.pc_product_id === 'string'
          ? product.metadata.pc_product_id
          : product.metadata?.pc_product_id != null
            ? String(product.metadata.pc_product_id)
            : null;
      let matchedName: string | null = null;
      if (!pcId) {
        if (!linkFirstHit) {
          kept.push(label);
          logger.warn(
            `⚠ ${label}: unlinked — rerun with --link-first-hit to auto-link`,
          );
          continue;
        }
        const hit = await searchPcId(product.title ?? '');
        if (!hit) throw new Error('no PriceCharting search match');
        pcId = hit.id;
        matchedName = hit.matched;
      }
      const stored = await resolveStored(pcId);
      await updateProductsWorkflow(container).run({
        input: {
          products: [
            {
              id: product.id,
              thumbnail: stored,
              images: [{ url: stored }],
              // Merge, never clobber: metadata carries fmv/points/grade etc.
              metadata: { ...product.metadata, pc_product_id: pcId },
            },
          ],
        },
      });
      const card = product.handle ? cardByHandle.get(product.handle) : null;
      if (card) {
        await packs.updateCards([{ id: card.id, image: stored }]);
        await rebakeCard(card, stored);
        doneHandles.add(card.handle);
      }
      replaced++;
      logger.info(
        `✓ ${label} ← pc:${pcId}${matchedName ? ` (matched "${matchedName}")` : ''}`,
      );
    } catch (e) {
      kept.push(label);
      logger.warn(
        `✗ ${label}: ${e instanceof Error ? e.message : String(e)} — kept existing image`,
      );
    }
    await sleep(1100); // PriceCharting is ~1 req/s — same pace as the daily job
  }

  // ---- 2. PC-linked gacha cards not covered by a product above ------------
  for (const card of allCards) {
    if (doneHandles.has(card.handle) || !card.pc_product_id) continue;
    if (only && card.handle !== only) continue;
    try {
      const stored = await resolveStored(String(card.pc_product_id));
      await packs.updateCards([{ id: card.id, image: stored }]);
      await rebakeCard(card, stored);
      replaced++;
      logger.info(`✓ card ${card.handle} ← pc:${card.pc_product_id}`);
    } catch (e) {
      kept.push(`card:${card.handle}`);
      logger.warn(
        `✗ card ${card.handle}: ${e instanceof Error ? e.message : String(e)} — kept existing image`,
      );
    }
    // A cache miss here hits the same PriceCharting endpoints as loop 1
    // (offers-page scrape + image download) — keep the same ~1 req/s pace.
    await sleep(1100);
  }

  logger.info(
    `repull-pc-images done: ${replaced} image(s) replaced, ${kept.length} kept.${kept.length ? ` Kept: ${kept.join(', ')}` : ''}`,
  );
}

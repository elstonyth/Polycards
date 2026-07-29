import { createStep, StepResponse } from '@medusajs/framework/workflows-sdk';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../modules/packs';
import type PacksModuleService from '../../modules/packs/service';

export type ReorderPacksInput = {
  order: { slug: string; rank: number }[];
};

type RankSnapshot = { id: string; rank: number }[];

// reorder-packs — persist list positions as rank writes, all in one service
// call so a swap can never half-apply. Rank is display ordering only (it never
// affects whether a pack is openable), so this step deliberately has no
// activation guard: reordering around an active empty-pool pack must work —
// the full-update guard in update-pack.ts keeps protecting real edits.
export const reorderPacksStep = createStep(
  'reorder-packs',
  async (input: ReorderPacksInput, { container }) => {
    const packs = container.resolve<PacksModuleService>(PACKS_MODULE);

    const slugs = input.order.map((o) => o.slug);
    const rows = await packs.listPacks({ slug: slugs }, { take: slugs.length });
    const bySlug = new Map(rows.map((p) => [p.slug, p]));

    const missing = slugs.filter((s) => !bySlug.has(s));
    if (missing.length > 0) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `Unknown pack slug(s): ${missing.join(', ')}.`,
      );
    }

    const snapshot: RankSnapshot = [];
    const writes: { id: string; rank: number }[] = [];
    for (const { slug, rank } of input.order) {
      const pack = bySlug.get(slug) as { id: string; rank: number };
      snapshot.push({ id: pack.id, rank: pack.rank });
      writes.push({ id: pack.id, rank });
    }

    await packs.updatePacks(writes);

    return new StepResponse({ updated: writes.length }, snapshot);
  },
  async (snapshot: RankSnapshot | undefined, { container }) => {
    if (!snapshot) return;
    const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
    await packs.updatePacks(snapshot);
  },
);

export default reorderPacksStep;

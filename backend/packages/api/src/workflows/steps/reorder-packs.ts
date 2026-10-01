import { createStep, StepResponse } from '@medusajs/framework/workflows-sdk';
import { MedusaError } from '@medusajs/framework/utils';
import type { MedusaContainer } from '@medusajs/framework/types';
import { PACKS_MODULE } from '../../modules/packs';
import type PacksModuleService from '../../modules/packs/service';
import { configAuditRow } from '../../modules/packs/config-audit';

export type ReorderPacksInput = {
  order: { slug: string; rank: number }[];
  // The acting admin (auth_context.actor_id) for the audit row.
  admin_id: string;
};

type RankSnapshot = { id: string; rank: number }[];

// reorder-packs — persist list positions as rank writes, all in one service
// call so a swap can never half-apply. Rank is display ordering only (it never
// affects whether a pack is openable), so this step deliberately has no
// activation guard: reordering around an active empty-pool pack must work —
// the full-update guard in update-pack.ts keeps protecting real edits.
//
// The output carries one audit row with the ranks that moved (null when none
// did) for the workflow's final record-admin-audit step.
export const reorderPacksInvoke = async (
  input: ReorderPacksInput,
  { container }: { container: MedusaContainer },
) => {
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
  const before: Record<string, number> = {};
  const after: Record<string, number> = {};
  for (const { slug, rank } of input.order) {
    const pack = bySlug.get(slug) as { id: string; rank: number };
    snapshot.push({ id: pack.id, rank: pack.rank });
    writes.push({ id: pack.id, rank });
    if (pack.rank !== rank) {
      before[slug] = pack.rank;
      after[slug] = rank;
    }
  }

  await packs.updatePacks(writes);

  const audit =
    Object.keys(after).length === 0
      ? null
      : configAuditRow({
          adminId: input.admin_id,
          entityType: 'pack',
          entityId: 'catalog',
          action: 'reorder',
          before: { ranks: before },
          after: { ranks: after },
        });

  return new StepResponse({ updated: writes.length, audit }, snapshot);
};

export const reorderPacksStep = createStep(
  'reorder-packs',
  reorderPacksInvoke,
  async (snapshot: RankSnapshot | undefined, { container }) => {
    if (!snapshot) return;
    const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
    await packs.updatePacks(snapshot);
  },
);

export default reorderPacksStep;

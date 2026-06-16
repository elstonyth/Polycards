import { createStep, StepResponse } from '@medusajs/framework/workflows-sdk';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../modules/packs';
import type PacksModuleService from '../../modules/packs/service';
import type { OddsRarity } from '@acme/odds-math';

export type SetPackMembersInput = {
  pack_id: string; // = Pack.slug
  card_ids: string[]; // the DESIRED full membership (Card.handle list)
};

// A freshly added member gets a positive relative weight so it can be rolled
// immediately (the roll is scale-invariant). The operator then fine-tunes the
// real percentages in the win-rate editor, which normalizes to basis points.
const NEW_MEMBER_WEIGHT = 100;

type RemovedRow = {
  pack_id: string;
  card_id: string;
  rarity: OddsRarity;
  weight: number;
  locked: boolean;
};
type CompensateData =
  | { createdIds: string[]; removed: RemovedRow[] }
  | undefined;

// set-pack-members — reconcile a pack's prize pool to a desired card set by
// DIFFING (add missing PackOdds rows, delete removed ones, leave shared rows —
// and their tuned weights — untouched). This is deliberately NOT save-pack-odds:
// that step rejects any change to the card set; this one IS the card-set change.
export const setPackMembersStep = createStep(
  'set-pack-members',
  async (input: SetPackMembersInput, { container }) => {
    const packs = container.resolve<PacksModuleService>(PACKS_MODULE);

    const [pack] = await packs.listPacks({ slug: input.pack_id }, { take: 1 });
    if (!pack) {
      throw new MedusaError(
        MedusaError.Types.NOT_FOUND,
        `Pack '${input.pack_id}' not found.`,
      );
    }

    const desired = Array.from(new Set(input.card_ids));

    // Every desired member must be a real Card (no dangling odds rows).
    if (desired.length) {
      const cards = await packs.listCards(
        { handle: desired },
        { take: desired.length },
      );
      const found = new Set(cards.map((c) => c.handle));
      const missing = desired.filter((h) => !found.has(h));
      if (missing.length) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          `Unknown card handle(s): ${missing.join(', ')}.`,
        );
      }
    }

    const existing = await packs.listPackOdds(
      { pack_id: input.pack_id },
      { take: 1000 },
    );
    const existingCards = new Set(existing.map((o) => o.card_id));
    const desiredSet = new Set(desired);

    const toAdd = desired.filter((h) => !existingCards.has(h));
    const toRemove = existing.filter((o) => !desiredSet.has(o.card_id));

    let createdIds: string[] = [];
    if (toAdd.length) {
      const created = await packs.createPackOdds(
        toAdd.map((card_id) => ({
          pack_id: input.pack_id,
          card_id,
          // New members join as Common; the operator picks the real per-pack
          // tier in the win-rate editor, which recomputes the weights from it.
          rarity: 'Common' as const,
          weight: NEW_MEMBER_WEIGHT,
          locked: false,
        })),
      );
      createdIds = created.map((c) => c.id);
    }
    if (toRemove.length) {
      await packs.deletePackOdds(toRemove.map((o) => o.id));
    }

    const removed: RemovedRow[] = toRemove.map((o) => ({
      pack_id: o.pack_id,
      card_id: o.card_id,
      rarity: o.rarity,
      weight: o.weight,
      locked: o.locked,
    }));

    return new StepResponse(
      {
        pack_id: input.pack_id,
        members: desired,
        added: toAdd.length,
        removed: toRemove.length,
      },
      { createdIds, removed } satisfies CompensateData,
    );
  },
  async (data: CompensateData, { container }) => {
    if (!data) return;
    const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
    if (data.createdIds.length) {
      await packs.deletePackOdds(data.createdIds);
    }
    if (data.removed.length) {
      await packs.createPackOdds(data.removed);
    }
  },
);

export default setPackMembersStep;

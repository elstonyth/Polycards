import { createStep, StepResponse } from '@medusajs/framework/workflows-sdk';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../modules/packs';
import type PacksModuleService from '../../modules/packs/service';
import {
  computeOdds,
  RARITIES,
  type OddsInput,
  type OddsRarity,
} from '@acme/odds-math';

export type SavePackOddsInput = {
  pack_id: string; // = Pack.slug
  entries: OddsInput[]; // one per card in the pack ({ card_id, locked, pct, rarity })
};

// OddsInput carries rarity as a plain string (the route validates it); narrow it
// back to the enum for the persistence layer, falling back to Common.
const toRarity = (s: string | undefined): OddsRarity =>
  (RARITIES as readonly string[]).includes(s ?? '')
    ? (s as OddsRarity)
    : 'Common';

// Snapshot used to restore the prior odds if a later step ever fails.
type OddsSnapshot = {
  id: string;
  rarity: OddsRarity;
  weight: number;
  locked: boolean;
};

// save-pack-odds — the one mutation in the win-rate editor: normalize a pack's
// per-card weights to basis points (Σ = 10000) per the rarity-weighted rules and
// persist rarity + weight + locked. Compensated by restoring the pre-save snapshot.
//
// Validation (reject → 400/404 via MedusaError, BEFORE any write):
//   - pack must exist and be active
//   - entries must cover exactly the pack's existing card set (no stale form /
//     injected card_ids)
//   - computeOdds must return no error (Σlocked ≤ 100; all-locked ⇒ Σ == 100;
//     each locked rate in 0–100)
export const savePackOddsStep = createStep(
  'save-pack-odds',
  async (input: SavePackOddsInput, { container }) => {
    const packs = container.resolve<PacksModuleService>(PACKS_MODULE);

    const [pack] = await packs.listPacks(
      { slug: input.pack_id, status: 'active' },
      { take: 1 },
    );
    if (!pack) {
      throw new MedusaError(
        MedusaError.Types.NOT_FOUND,
        `Pack '${input.pack_id}' is not available.`,
      );
    }

    const existing = await packs.listPackOdds(
      { pack_id: input.pack_id },
      { take: 1000 },
    );
    if (existing.length === 0) {
      throw new MedusaError(
        MedusaError.Types.NOT_FOUND,
        `Pack '${input.pack_id}' has no odds configured.`,
      );
    }

    // The submitted entries must match the pack's card set exactly — guards
    // against a stale form (cards added/removed since load) or injected ids.
    const existingIds = new Set(existing.map((o) => o.card_id));
    const submittedIds = new Set(input.entries.map((e) => e.card_id));
    const sameSet =
      existingIds.size === submittedIds.size &&
      [...existingIds].every((id) => submittedIds.has(id));
    if (!sameSet) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "Submitted cards do not match this pack's prize pool. Reload and retry.",
      );
    }

    const { computed, error } = computeOdds(input.entries);
    if (error) {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, error);
    }

    const idByCard = new Map(existing.map((o) => [o.card_id, o.id]));
    // Rarity rides along with the save: the editor chooses the per-pack tier and
    // the weights computed FROM it in one submit.
    const rarityByCard = new Map(
      input.entries.map((e) => [e.card_id, e.rarity]),
    );
    const updates = computed.map((c) => ({
      id: idByCard.get(c.card_id)!,
      rarity: toRarity(rarityByCard.get(c.card_id)),
      weight: c.weight,
      locked: c.locked,
    }));

    const snapshot: OddsSnapshot[] = existing.map((o) => ({
      id: o.id,
      rarity: o.rarity,
      weight: o.weight,
      locked: o.locked,
    }));

    await packs.updatePackOdds(updates);

    // Return the computed odds; carry the snapshot as the compensation payload.
    return new StepResponse(computed, snapshot);
  },
  async (snapshot, { container }) => {
    if (!snapshot) return;
    const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
    await packs.updatePackOdds(snapshot);
  },
);

export default savePackOddsStep;

import { createStep, StepResponse } from '@medusajs/framework/workflows-sdk';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../modules/packs';
import type PacksModuleService from '../../modules/packs/service';
import {
  computeSetWeights,
  RARITIES,
  type SetEntry,
  type OddsRarity,
} from '@acme/odds-math';

export type SavePackOddsInput = {
  pack_id: string; // = Pack.slug
  // One per card in the pack: { card_id, locked, pct, rarity } plus the set-2/3
  // overrides (pct_2 / pct_3 — null = inherit the previous set for that card).
  entries: SetEntry[];
};

// OddsInput carries rarity as a plain string (the route validates it); narrow it
// back to the enum for the persistence layer, falling back to Common.
const toRarity = (s: string | undefined): OddsRarity =>
  (RARITIES as readonly string[]).includes(s ?? '')
    ? (s as OddsRarity)
    : 'Common';

// Snapshot used to restore the prior odds if a later step ever fails. It MUST
// carry weight_2/weight_3: a compensation that restored only `weight` would
// silently wipe the pack's set-2/3 tables.
type OddsSnapshot = {
  id: string;
  rarity: OddsRarity;
  weight: number;
  weight_2: number | null;
  weight_3: number | null;
  locked: boolean;
};

// save-pack-odds — the one mutation in the win-rate editor: normalize a pack's
// per-card weights to basis points (Σ = 10000) with Common as the balancer and
// persist rarity + weight/weight_2/weight_3 + locked. All THREE sets are
// recomputed on every save (see computeSetWeights' storage rule), so a set-1
// edit keeps sets 2/3 summing to 10000. Compensated by restoring the pre-save
// snapshot.
//
// Validation (reject → 400/404 via MedusaError, BEFORE any write):
//   - pack must exist — DRAFT included: draft is the designated authoring
//     state (create draft → add cards → save win rates → activate), so the
//     editor must be able to save before activation
//   - entries must cover exactly the pack's existing card set (no stale form /
//     injected card_ids)
//   - computeSetWeights must return no error, for EVERY set (Σpinned ≤ 100;
//     no unlocked Common ⇒ Σ == 100 exactly; each rate in 0–100). Set 2/3
//     failures come back prefixed 'Set N: '.
export const savePackOddsStep = createStep(
  'save-pack-odds',
  async (input: SavePackOddsInput, { container }) => {
    const packs = container.resolve<PacksModuleService>(PACKS_MODULE);

    const [pack] = await packs.listPacks({ slug: input.pack_id }, { take: 1 });
    if (!pack) {
      throw new MedusaError(
        MedusaError.Types.NOT_FOUND,
        `Pack '${input.pack_id}' is not available.`,
      );
    }

    const allExisting = await packs.listPackOdds(
      { pack_id: input.pack_id },
      { take: 1000 },
    );
    // The win-rate editor only ever touches card rows — reward rows (card_id
    // null) are managed elsewhere and must not be matched/normalized here.
    const existing = allExisting.filter(
      (o): o is typeof o & { card_id: string; rarity: OddsRarity } =>
        o.card_id != null,
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

    const { rows, error } = computeSetWeights(input.entries);
    if (error) {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, error);
    }

    const idByCard = new Map(existing.map((o) => [o.card_id, o.id]));
    // Rarity rides along with the save: the editor chooses the per-pack tier and
    // the weights computed FROM it in one submit.
    const rarityByCard = new Map(
      input.entries.map((e) => [e.card_id, e.rarity]),
    );
    // weight_2/weight_3 are written UNCONDITIONALLY (null included): dropping
    // the only explicit pct_2 returns that set to pure inheritance, and the
    // stale materialized bps must be cleared, not left behind.
    const updates = rows.map((r) => ({
      id: idByCard.get(r.card_id)!,
      rarity: toRarity(rarityByCard.get(r.card_id)),
      weight: r.weight,
      weight_2: r.weight_2,
      weight_3: r.weight_3,
      locked: r.locked,
    }));

    const snapshot: OddsSnapshot[] = existing.map((o) => ({
      id: o.id,
      rarity: o.rarity,
      weight: o.weight,
      weight_2: o.weight_2 ?? null,
      weight_3: o.weight_3 ?? null,
      locked: o.locked,
    }));

    await packs.updatePackOdds(updates);

    // Response contract (unchanged for the editor): the SET-1 computed odds.
    const computed = rows.map((r) => ({
      card_id: r.card_id,
      weight: r.weight,
      locked: r.locked,
      pct: r.weight / 100,
    }));

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

import { createStep, StepResponse } from '@medusajs/framework/workflows-sdk';
import { MedusaError } from '@medusajs/framework/utils';
import type { MedusaContainer } from '@medusajs/framework/types';
import { PACKS_MODULE } from '../../modules/packs';
import type PacksModuleService from '../../modules/packs/service';
import {
  computeSetWeights,
  PCT_SCALE,
  type SetEntry,
  type OddsRarity,
} from '@acme/odds-math';
import { pageAll } from '../../api/utils/page-all';

export type SetPackMembersInput = {
  pack_id: string; // = Pack.slug
  card_ids: string[]; // the DESIRED full membership (Card.handle list)
};

// A freshly added member gets a positive relative weight so it can be rolled
// immediately (the roll is scale-invariant). The operator then fine-tunes the
// real percentages in the win-rate editor, which normalizes to integer units.
// Only used on the degraded path (the pool can't be balanced — see below);
// normally the new member comes out of computeSetWeights as a balancer.
const NEW_MEMBER_WEIGHT = 10_000; // ~1% of a normalized 1,000,000-unit pool

// Snapshots MUST carry weight_2/weight_3: a compensation that restored only
// `weight` would silently wipe the pack's set-2/3 tables (same rule as
// save-pack-odds' snapshot).
type RemovedRow = {
  pack_id: string;
  card_id: string;
  rarity: OddsRarity;
  weight: number;
  weight_2: number | null;
  weight_3: number | null;
  locked: boolean;
};
type CompensateData =
  | {
      createdIds: string[];
      removed: RemovedRow[];
      /** Survivors' pre-renormalization weights, for rollback. */
      reweighted: {
        id: string;
        weight: number;
        weight_2: number | null;
        weight_3: number | null;
      }[];
    }
  | undefined;

// set-pack-members — reconcile a pack's prize pool to a desired card set by
// DIFFING (add missing PackOdds rows, delete removed ones, leave shared rows —
// and their tuned weights — untouched). This is deliberately NOT save-pack-odds:
// that step rejects any change to the card set; this one IS the card-set change.
//
// The invoke handler is a named export so the unit suite can drive it with a
// stubbed container (same pattern as create-card's registerCardInvoke).
export const setPackMembersInvoke = async (
  input: SetPackMembersInput,
  { container }: { container: MedusaContainer },
) => {
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

  // PAGED, not take:1000 — the reconcile diff must see EVERY existing row or
  // a row past the cap looks "missing" and gets re-added, silently doubling
  // that card's weight (the DB now also blocks the duplicate via
  // UQ_pack_odds_pack_card, but the read must be correct so the diff doesn't
  // 500 on the constraint for a legitimately-present card).
  const allExisting = await pageAll((opts) =>
    packs.listPackOdds({ pack_id: input.pack_id }, opts),
  );
  // Reconcile CARD membership only — reward rows (card_id null) are not cards
  // and must never be flagged for removal by a desired-card-set diff.
  // Membership is keyed on card_id ONLY — a card row with a null rarity (legacy)
  // must still reconcile, or it would be re-added as a duplicate. So the guard
  // narrows card_id (non-null) but NOT rarity; the rare null rarity is defaulted
  // where it's consumed (the RemovedRow compensation snapshot below).
  const existing = allExisting.filter(
    (o): o is typeof o & { card_id: string } => o.card_id != null,
  );
  const existingCards = new Set(existing.map((o) => o.card_id));
  const desiredSet = new Set(desired);

  const toAdd = desired.filter((h) => !existingCards.has(h));
  const toRemove = existing.filter((o) => !desiredSet.has(o.card_id));

  // An ACTIVE pack must keep a ROLLABLE pool — the resulting membership
  // needs at least one positive-weight card row or every storefront spin
  // would fail (roll-pack rejects an empty/zero-weight pool). This covers
  // both emptying the pool AND stripping it down to only zero-weight rows
  // (a card can sit at weight 0 when locked rates sum to 100). New members
  // join at a positive weight, so only pure-removal edits can break it.
  // reward_box packs are internal draw pools (reward rows, card_id null)
  // whose card membership is legitimately empty.
  if (
    pack.status === 'active' &&
    pack.category !== 'reward_box' &&
    toAdd.length === 0
  ) {
    const keptRollable = existing.some(
      (o) => desiredSet.has(o.card_id) && o.weight > 0,
    );
    if (!keptRollable) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `Pack '${input.pack_id}' is active — this change would leave its ` +
          'prize pool with no winnable cards. Set the pack to draft first.',
      );
    }
  }

  // Re-normalize so a membership edit can never dilute a tuned win rate:
  // appending a row to a normalized Σ=TOTAL_UNITS pool would otherwise shave every
  // rate, and since the UI no longer shows weights nobody would notice — the
  // next save would bake the diluted rate in permanently.
  //
  // SEMANTIC SHIFT (POLYCARD-BACK §2.4, Common as balancer): survivors' pcts
  // are now taken VERBATIM — locked or not. The old code re-split the unlocked
  // survivors by rarity; under the balancer only the UNLOCKED COMMON rows move,
  // absorbing whatever the edit freed (or funding what it consumed). Pcts are
  // derived from the ORIGINAL pool total (removed rows included), so survivors
  // keep their pre-edit effective % and Common eats the difference.
  //
  // All THREE sets are recomputed: a survivor's explicit weight_2/weight_3 is
  // fed back in as pct_2/pct_3 so an appended/removed card can't leave set 2/3
  // resolving to its full total. New members enter unlocked/Common
  // with no set overrides (spec §2.2 — the operator sets their rates in the
  // editor afterwards); being an unlocked Common makes them a balancer, so they
  // come out of the box with a rollable share of the remainder.
  //
  // computeSetWeights is pure, so the weights are derived BEFORE any write —
  // new members are created directly at their final normalized weight. Skipped
  // only when the result can't be honored (e.g. a pure removal leaving a pool
  // with no unlocked Common whose pinned rates no longer sum to 100); the draw
  // itself is scale-invariant, so untouched weights still roll proportionally.
  const originalTotal = existing.reduce((s, o) => s + o.weight, 0) || 1;
  const survivors = existing.filter((o) => desiredSet.has(o.card_id));
  const entries: SetEntry[] = [
    ...survivors.map((o) => ({
      card_id: o.card_id,
      locked: o.locked,
      pct: (o.weight / originalTotal) * 100,
      rarity: (o.rarity ?? 'Common') as string,
      pct_2: o.weight_2 != null ? o.weight_2 / PCT_SCALE : null,
      pct_3: o.weight_3 != null ? o.weight_3 / PCT_SCALE : null,
    })),
    ...toAdd.map((card_id) => ({
      card_id,
      locked: false,
      rarity: 'Common',
      pct: 0,
      pct_2: null,
      pct_3: null,
    })),
  ];
  type ComputedRow = {
    weight: number;
    weight_2: number | null;
    weight_3: number | null;
  };
  const rowByCard: Map<string, ComputedRow> | null = (() => {
    if (entries.length === 0) return null;
    const { rows, error } = computeSetWeights(entries);
    if (error) {
      // Operator signal: the reweight safeguard did NOT apply — the pool
      // needs a manual pass in the win-rate editor (e.g. a pure removal
      // left a pool with no unlocked Common whose rates no longer sum to 100).
      console.warn(
        `set-pack-members: skipped auto-reweight for '${input.pack_id}': ${error}`,
      );
      return null;
    }
    return new Map(
      rows.map((r) => [
        r.card_id,
        { weight: r.weight, weight_2: r.weight_2, weight_3: r.weight_3 },
      ]),
    );
  })();

  // DEGRADED PATH — collapse sets 2/3 to NULL (= inherit set 1) for every
  // survivor that still carries an explicit one. Leaving them verbatim can
  // strand a set at a resolved total of ZERO (remove the only card holding
  // set 2's weight and the survivors' stored weight_2 = 0 is all that's left),
  // which set 1's activation guard and rollablePool both miss — the customers
  // in that group would then fail EVERY spin, forever, signalled by nothing but
  // the console.warn above. Set 1 is already proven rollable by the guard, so
  // inheriting it fails safe. Cost: the operator re-types those set-2/3 rates
  // on the next successful save.
  const collapse = rowByCard
    ? []
    : survivors.filter((o) => o.weight_2 != null || o.weight_3 != null);

  // Create + delete + reweigh land in ONE transaction (applyPackMemberDiff):
  // a failed step never runs its own compensation, so without the txn a
  // mid-diff crash could leave the pool half-migrated.
  const reweighted = (rowByCard ? survivors : collapse).map((o) => ({
    id: o.id,
    weight: o.weight,
    weight_2: o.weight_2 ?? null,
    weight_3: o.weight_3 ?? null,
  }));
  const { created_ids: createdIds } = await packs.applyPackMemberDiff({
    pack_id: input.pack_id,
    create: toAdd.map((card_id) => {
      const row = rowByCard?.get(card_id);
      return {
        pack_id: input.pack_id,
        card_id,
        // New members join as Common; the operator picks the real per-pack
        // tier in the pool editor, which recomputes the weights from it.
        rarity: 'Common' as const,
        weight: row?.weight ?? NEW_MEMBER_WEIGHT,
        // null (the degraded path included) = inherit the previous set.
        weight_2: row?.weight_2 ?? null,
        weight_3: row?.weight_3 ?? null,
        locked: false,
      };
    }),
    remove_ids: toRemove.map((o) => o.id),
    // Compared across ALL THREE sets: a row's set-1 weight can be unchanged
    // while its materialized weight_2/weight_3 moved (e.g. dropping a
    // zero-weight card that carried an explicit pct_2), and skipping it there
    // would leave that set resolving short of the full total.
    reweigh: rowByCard
      ? survivors.flatMap((o) => {
          const row = rowByCard.get(o.card_id);
          if (
            row === undefined ||
            (row.weight === o.weight &&
              row.weight_2 === (o.weight_2 ?? null) &&
              row.weight_3 === (o.weight_3 ?? null))
          ) {
            return [];
          }
          return [{ id: o.id, ...row }];
        })
      : collapse.map((o) => ({
          id: o.id,
          weight: o.weight,
          weight_2: null,
          weight_3: null,
        })),
  });

  const removed: RemovedRow[] = toRemove.map((o) => ({
    pack_id: o.pack_id,
    card_id: o.card_id,
    // Card rows carry a per-pack tier; default a legacy null to 'Common' so the
    // compensation re-insert restores a valid, weight-able row.
    rarity: o.rarity ?? 'Common',
    weight: o.weight,
    weight_2: o.weight_2 ?? null,
    weight_3: o.weight_3 ?? null,
    locked: o.locked,
  }));

  return new StepResponse(
    {
      pack_id: input.pack_id,
      members: desired,
      added: toAdd.length,
      removed: toRemove.length,
    },
    { createdIds, removed, reweighted } satisfies CompensateData,
  );
};

export const setPackMembersStep = createStep(
  'set-pack-members',
  setPackMembersInvoke,
  async (data: CompensateData, { container }) => {
    if (!data) return;
    const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
    if (data.createdIds.length) {
      await packs.deletePackOdds(data.createdIds);
    }
    if (data.removed.length) {
      await packs.createPackOdds(data.removed);
    }
    if (data.reweighted?.length) {
      await packs.updatePackOdds(data.reweighted);
    }
  },
);

export default setPackMembersStep;

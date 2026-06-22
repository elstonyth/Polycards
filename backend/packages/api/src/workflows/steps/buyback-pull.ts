import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk";
import {
  ContainerRegistrationKeys,
  MedusaError,
  Modules,
} from "@medusajs/framework/utils";
import { PACKS_MODULE } from "../../modules/packs";
import type PacksModuleService from "../../modules/packs/service";
import { findCardInventoryTarget } from "../../modules/packs/card-stock";
import {
  buybackAmount,
  resolveBuybackRate,
  type BuybackRateType,
} from "../../modules/packs/buyback-rate";
import { insertOrMapDuplicate } from "./duplicate-race";

export type BuybackPullInput = {
  pull_id: string;
  customer_id: string; // from the authenticated token — NEVER the request body
};

export type BuybackResult = {
  pull_id: string;
  /** USD credited (decimal, never cents). */
  amount: number;
  /** The buyback percent actually applied. */
  percent: number;
  /** Which rate applied: instant (within the post-pull window) or vault. */
  rate_type: BuybackRateType;
  /** The customer's new credit balance (Σ ledger). */
  balance: number;
};

type CompensateData =
  | {
      pullId: string;
      creditTransactionId: string;
      stockTarget: { inventoryItemId: string; locationId: string } | null;
    }
  | undefined;

// buyback-pull — the customer sells a vaulted pull back to the house: the pull
// flips to bought_back, the credit ledger gains current-FMV × pack-% , and the
// physical unit returns to stock (best-effort, mirror of the pull's earmark).
//
// Order matters: the credit row is written FIRST because its UNIQUE pull_id is
// the race guard — a concurrent duplicate buyback dies on the constraint before
// anything else mutates. The later mutations are manually undone on failure so
// the step stays atomic; compensation covers later-step failures.
export const buybackPullStep = createStep(
  "buyback-pull",
  async (input: BuybackPullInput, { container }) => {
    const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
    const logger = container.resolve(ContainerRegistrationKeys.LOGGER);

    const [pull] = await packs.listPulls({ id: input.pull_id }, { take: 1 });
    // Unknown id and someone else's pull are the SAME 404 — don't leak which
    // pull ids exist to other customers.
    if (!pull || pull.customer_id !== input.customer_id) {
      throw new MedusaError(
        MedusaError.Types.NOT_FOUND,
        `Pull '${input.pull_id}' not found.`
      );
    }
    if (pull.status !== "vaulted") {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        "This card was already sold back."
      );
    }

    const [card] = await packs.listCards({ handle: pull.card_id }, { take: 1 });
    if (!card) {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        "This card is no longer in the catalog and cannot be valued."
      );
    }

    // Instant rate inside the post-pull window (the reveal's "sell on the
    // spot"), the flat rate after — decided HERE from rolled_at, never by the
    // caller, so the better rate can't be claimed late via the raw API.
    const [pack] = await packs.listPacks({ slug: pull.pack_id }, { take: 1 });
    const { percent, rate_type } = resolveBuybackRate(pack, {
      rolled_at: pull.rolled_at,
      revealed_at: pull.revealed_at,
    });

    // A money amount must never be computed from a corrupt FMV — refuse rather
    // than credit NaN/garbage (the column is NOT NULL numeric, so this only
    // fires on real data corruption).
    const marketValue = Number(card.market_value);
    if (!Number.isFinite(marketValue) || marketValue < 0) {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        "This card has no valid market value and cannot be sold back."
      );
    }
    const amount = buybackAmount(marketValue, percent);

    // 1. Credit row first — the unique pull_id kills concurrent duplicates here.
    const [txn] = await insertOrMapDuplicate({
      insert: () =>
        packs.createCreditTransactions([
          {
            customer_id: input.customer_id,
            amount,
            reason: "buyback" as const,
            pull_id: pull.id,
          },
        ]),
      probeDuplicate: async () => {
        const [existing] = await packs.listCreditTransactions(
          { pull_id: pull.id },
          { take: 1 }
        );
        return existing !== undefined;
      },
      duplicateError: () =>
        new MedusaError(
          MedusaError.Types.NOT_ALLOWED,
          "This card was already sold back."
        ),
      logger,
      label: "buyback-pull",
    });
    const creditTransactionId = txn.id;

    // 2. Flip the pull. If this fails, remove the credit row so nothing is
    //    half-applied (compensation only covers later-step failures).
    try {
      await packs.updatePulls([
        {
          id: pull.id,
          status: "bought_back" as const,
          buyback_amount: amount,
          buyback_at: new Date(),
        },
      ]);
    } catch (error) {
      // The undo itself failing leaves credit-without-flip — loud trail so the
      // inconsistent pair (pull, txn) can be repaired by hand.
      try {
        await packs.deleteCreditTransactionsGuarded([creditTransactionId]);
      } catch (undoError) {
        logger.error(
          `buyback-pull: UNDO FAILED — credit txn '${creditTransactionId}' exists but pull '${pull.id}' was not flipped; repair manually. ${
            undoError instanceof Error ? undoError.message : String(undoError)
          }`
        );
      }
      throw error;
    }

    // 3. Return the physical unit to stock — ONLY if this pull actually took
    //    one (stock_earmarked): a pull made at 0 stock / on an untracked
    //    product never decremented, so restoring it would mint a phantom unit.
    //    The flag clears with the restore (and compensation re-sets it) so the
    //    earmark and the counter always agree. Best-effort: errors only warn.
    let stockTarget: { inventoryItemId: string; locationId: string } | null =
      null;
    try {
      if (pull.stock_earmarked) {
        const target = await findCardInventoryTarget(container, pull.card_id);
        if (target) {
          const inventoryModule = container.resolve(Modules.INVENTORY);
          await inventoryModule.adjustInventory(
            target.inventoryItemId,
            target.locationId,
            1
          );
          await packs.updatePulls([{ id: pull.id, stock_earmarked: false }]);
          stockTarget = {
            inventoryItemId: target.inventoryItemId,
            locationId: target.locationId,
          };
        }
      }
    } catch (error) {
      logger.warn(
        `buyback-pull: could not restore stock for '${pull.card_id}' — buyback continues. ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    // New balance = paged Σ ledger (append-only; exact at any ledger size).
    const balance = await packs.creditBalance(input.customer_id);

    const result: BuybackResult = {
      pull_id: pull.id,
      amount,
      percent,
      rate_type,
      balance,
    };
    return new StepResponse(result, {
      pullId: pull.id,
      creditTransactionId,
      stockTarget,
    } satisfies CompensateData);
  },
  async (data: CompensateData, { container }) => {
    if (!data) return;
    const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
    await packs.deleteCreditTransactionsGuarded([data.creditTransactionId]);
    await packs.updatePulls([
      {
        id: data.pullId,
        status: "vaulted" as const,
        buyback_amount: null,
        buyback_at: null,
        // A restored unit goes back out and the earmark returns with it, so a
        // later (re-)buyback of the re-vaulted pull restores correctly.
        ...(data.stockTarget ? { stock_earmarked: true } : {}),
      },
    ]);
    if (data.stockTarget) {
      const inventoryModule = container.resolve(Modules.INVENTORY);
      await inventoryModule.adjustInventory(
        data.stockTarget.inventoryItemId,
        data.stockTarget.locationId,
        -1
      );
    }
  }
);

export default buybackPullStep;

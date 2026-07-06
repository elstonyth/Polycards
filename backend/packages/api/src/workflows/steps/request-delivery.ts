import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk";
import {
  ContainerRegistrationKeys,
  MedusaError,
  Modules,
} from "@medusajs/framework/utils";
import { PACKS_MODULE } from "../../modules/packs";
import type PacksModuleService from "../../modules/packs/service";
import {
  validateDeliveryRequest,
  snapshotAddress,
} from "../../modules/packs/delivery";

export type RequestDeliveryInput = {
  customer_id: string; // from the authenticated token — NEVER the request body
  pull_ids: string[];
  address_id: string;
};

export type RequestDeliveryResult = {
  order_id: string;
  status: "requested";
  pull_ids: string[];
};

type CompensateData =
  | { orderId: string; itemIds: string[]; pullIds: string[] }
  | undefined;

const verdictError = (
  v: ReturnType<typeof validateDeliveryRequest>,
): MedusaError => {
  switch (v) {
    case "empty":
      return new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "Select at least one card to deliver.",
      );
    case "duplicate":
      return new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "Duplicate cards in the selection.",
      );
    case "not_vaulted":
      return new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        "One or more cards are no longer available to deliver.",
      );
    case "reward_source":
      return new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        "Reward prizes are shipped from the rewards page, not the vault.",
      );
    // not_found AND forbidden both surface as 404 — no cross-account leak.
    default:
      return new MedusaError(
        MedusaError.Types.NOT_FOUND,
        "One or more cards were not found.",
      );
  }
};

export const requestDeliveryStep = createStep(
  "request-delivery",
  async (input: RequestDeliveryInput, { container }) => {
    const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
    const customerModule = container.resolve(Modules.CUSTOMER);
    const logger = container.resolve(ContainerRegistrationKeys.LOGGER);

    // 1. Validate the selection (ownership + vaulted).
    const pulls = input.pull_ids.length
      ? await packs.listPulls(
          { id: input.pull_ids },
          { take: input.pull_ids.length },
        )
      : [];
    const verdict = validateDeliveryRequest(
      pulls,
      input.pull_ids,
      input.customer_id,
    );
    if (verdict !== "ok") throw verdictError(verdict);

    // Frozen accounts cannot draw value out — physical delivery extracts value
    // exactly like buyback, so it gets the same gate (audit 2026-07-07 #2).
    await packs.assertNotFrozen(input.customer_id);

    // 2. Resolve + verify the address belongs to the caller, then snapshot it.
    const [address] = await customerModule.listCustomerAddresses(
      { id: input.address_id, customer_id: input.customer_id },
      { take: 1 },
    );
    if (!address) {
      throw new MedusaError(
        MedusaError.Types.NOT_FOUND,
        "Shipping address not found.",
      );
    }
    const snapshot = snapshotAddress(address);
    if (!snapshot) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "That address is missing required shipping fields.",
      );
    }

    // 3. Create the order.
    const [order] = await packs.createDeliveryOrders([
      { customer_id: input.customer_id, status: "requested", ...snapshot },
    ]);

    // 4. Create the items (manual undo if this throws — order already exists).
    let itemIds: string[] = [];
    try {
      const items = await packs.createDeliveryOrderItems(
        input.pull_ids.map((pull_id) => ({
          delivery_order_id: order.id,
          pull_id,
        })),
      );
      itemIds = items.map((i) => i.id);
    } catch (error) {
      try {
        await packs.deleteDeliveryOrders([order.id]);
      } catch (undoError) {
        logger.error(
          `request-delivery: UNDO FAILED — order '${order.id}' exists with no items; repair manually. ${
            undoError instanceof Error ? undoError.message : String(undoError)
          }`,
        );
      }
      throw error;
    }

    // 5. Flip pulls vaulted → delivering (manual undo on failure).
    try {
      await packs.transitionPullStatus({
        ids: input.pull_ids,
        from: "vaulted",
        to: "delivering",
      });
    } catch (error) {
      try {
        await packs.deleteDeliveryOrderItems(itemIds);
        await packs.deleteDeliveryOrders([order.id]);
      } catch (undoError) {
        logger.error(
          `request-delivery: UNDO FAILED after pull flip — order '${order.id}'; repair manually. ${
            undoError instanceof Error ? undoError.message : String(undoError)
          }`,
        );
      }
      throw error;
    }

    const result: RequestDeliveryResult = {
      order_id: order.id,
      status: "requested",
      pull_ids: input.pull_ids,
    };
    return new StepResponse(result, {
      orderId: order.id,
      itemIds,
      pullIds: input.pull_ids,
    } satisfies CompensateData);
  },
  // COMPENSATION — reverse everything if a later step fails.
  async (data: CompensateData, { container }) => {
    if (!data) return;
    const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
    await packs.updatePulls(
      data.pullIds.map((id) => ({ id, status: "vaulted" as const })),
    );
    await packs.deleteDeliveryOrderItems(data.itemIds);
    await packs.deleteDeliveryOrders([data.orderId]);
  },
);

export default requestDeliveryStep;

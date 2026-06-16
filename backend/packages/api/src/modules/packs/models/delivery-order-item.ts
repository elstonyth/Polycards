import { model } from "@medusajs/framework/utils";

// DeliveryOrderItem — join between a DeliveryOrder and the Pull being shipped.
// One order → many items. pull_id is NOT globally unique (a canceled order
// returns the pull to the vault, where it can be re-requested), but a pull can
// only be in ONE active order at a time — that invariant is enforced by the
// Pull.status === "vaulted" gate in requestDeliveryWorkflow, not a DB constraint.
export const DeliveryOrderItem = model
  .define("delivery_order_item", {
    id: model.id().primaryKey(),
    delivery_order_id: model.text(),
    pull_id: model.text(),
  })
  .indexes([
    {
      name: "IDX_delivery_order_item_order_id",
      on: ["delivery_order_id"],
      where: "deleted_at IS NULL",
    },
    {
      name: "IDX_delivery_order_item_pull_id",
      on: ["pull_id"],
      where: "deleted_at IS NULL",
    },
  ]);

export default DeliveryOrderItem;

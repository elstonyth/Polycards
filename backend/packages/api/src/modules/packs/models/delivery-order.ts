import { model } from '@medusajs/framework/utils';

// DeliveryOrder — a customer's request to physically ship one or more vaulted
// cards. The address is a DENORMALIZED SNAPSHOT taken from the Medusa customer
// address book at request time, so later edits to the address book never
// rewrite a shipped order. v1: address-only — shipping_fee is reserved (nullable,
// no charge logic yet).
export const DeliveryOrder = model
  .define('delivery_order', {
    id: model.id().primaryKey(),
    customer_id: model.text(),
    status: model
      .enum([
        'requested',
        'processed',
        'ready_to_ship',
        'shipped',
        'completed',
        'canceled',
      ])
      .default('requested'),
    // Address snapshot (denormalized from StoreCustomerAddress at request time).
    ship_name: model.text(),
    ship_address_1: model.text(),
    ship_address_2: model.text().nullable(),
    ship_city: model.text(),
    ship_province: model.text().nullable(),
    ship_postal_code: model.text(),
    ship_country_code: model.text(),
    ship_phone: model.text().nullable(),
    // Operator-entered (manual) — no carrier integration in v1.
    tracking_number: model.text().nullable(),
    // Proof-of-delivery photos (operator-uploaded /admin/media URLs). Stored as a
    // string[] — visible to the customer on their orders page. Array (not object)
    // so an update replaces it wholesale (Medusa's assign merges POJOs but
    // replaces arrays), keeping the remove-all path a clean clear to [].
    proof_images: model.json().nullable(),
    // Zone shipping charge in MYR (West RM15 / East RM35 by postcode), stamped
    // at request since 2026-08-25 and debited from the wallet in the same
    // transaction. NULL only on pre-fee orders and reward-prize shipments.
    shipping_fee: model.bigNumber().nullable(),
    // Mandatory 5% insurance on the full order card value when it exceeds
    // RM200 (see computeDeliveryFee in delivery.ts); 0 when covered by the
    // included RM200 protection, NULL on pre-fee orders.
    insurance_fee: model.bigNumber().nullable(),
    shipped_at: model.dateTime().nullable(),
    // Column name predates the processed/ready_to_ship/completed rename — it
    // now stamps when status hits 'completed', not a literal "delivered" status.
    delivered_at: model.dateTime().nullable(),
    // True when this shipment fulfils a reward-economy prize (Pull.source='reward').
    // Used by recordRewardWithdrawal for the daily withdrawal cap COUNT.
    is_reward: model.boolean().default(false),
  })
  .indexes([
    {
      name: 'IDX_delivery_order_customer_id_created_at',
      on: ['customer_id', 'created_at'],
      where: 'deleted_at IS NULL',
    },
    {
      name: 'IDX_delivery_order_status',
      on: ['status'],
      where: 'deleted_at IS NULL',
    },
  ]);

export default DeliveryOrder;

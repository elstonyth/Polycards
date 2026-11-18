// The JSON body of GET /store/delivery-orders, written once (ADR 0018). Types
// only. No imports: the storefront typecheck reads this file (as
// `@acme/api/store/delivery-orders`) without the backend's node_modules.

export type StoreDeliveryOrderItem = {
  pull_id: string;
  challenge_prize: boolean;
  lucky_draw_prize: boolean;
  /** null when the pull or its card is gone. */
  card: {
    handle: string;
    name: string;
    image: string;
    slab_image: string | null;
  } | null;
};

export type StoreDeliveryOrder = {
  id: string;
  customer_id: string;
  status: string;
  address: {
    name: string;
    address_1: string;
    address_2: string | null;
    city: string;
    province: string | null;
    postal_code: string;
    country_code: string;
    phone: string | null;
  };
  tracking_number: string | null;
  /** null (not 0) on pre-fee orders and reward-prize shipments. */
  shipping_fee: number | null;
  insurance_fee: number | null;
  proof_images: string[];
  shipped_at: string | null;
  delivered_at: string | null;
  created_at: string;
  items: StoreDeliveryOrderItem[];
};

export type StoreDeliveryOrdersResponse = { items: StoreDeliveryOrder[] };

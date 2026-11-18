import { z } from './zod';
import { finite, listOf } from './shared';

/** GET /store/delivery-orders item — guards the fields the mapper consumes. */
export const DeliveryOrderSchema = z.looseObject({
  id: z.string(),
  // TRANSITIONAL (one release): old ∪ new status vocabulary. During a deploy the
  // storefront ships before/after the backend, so an old backend can still emit
  // `packing`/`delivered` — and parseList DROPS a row that fails the schema, i.e.
  // a stale status would make the customer's order VANISH from /orders rather
  // than render with an odd label. Narrow to the 6 new values next release.
  status: z.enum([
    'requested',
    'packing',
    'processed',
    'ready_to_ship',
    // Packed, waiting for the courier (2026-11-07); reads "Ready to ship".
    'pending_ship',
    'shipped',
    'delivered',
    'completed',
    'canceled',
  ]),
  created_at: z.string(),
  tracking_number: z.string().nullable().optional(),
  // Wallet charge stamped at request since 2026-08-25. Optional AND nullable:
  // an old backend omits them, pre-fee orders carry null — parseList must
  // keep both rendering.
  shipping_fee: finite.nullable().optional(),
  insurance_fee: finite.nullable().optional(),
  // The backend has always sent the full shipping snapshot (delivery-view.ts);
  // only name/city/country_code were declared, so the rest was silently dropped
  // by the view mapping. The street lines are OPTIONAL here on purpose: an old
  // backend that omits them must still parse, or parseList drops the whole row
  // and the customer's order vanishes from /orders.
  address: z
    .looseObject({
      name: z.string(),
      address_1: z.string().nullable().optional(),
      address_2: z.string().nullable().optional(),
      city: z.string(),
      province: z.string().nullable().optional(),
      postal_code: z.string().nullable().optional(),
      country_code: z.string(),
      phone: z.string().nullable().optional(),
    })
    .optional(),
  items: z
    .array(
      z.looseObject({
        pull_id: z.string(),
        card: z
          .looseObject({
            handle: z.string(),
            name: z.string(),
            image: z.string(),
          })
          .nullable(),
      }),
    )
    .optional(),
});

/** GET /store/delivery-orders — the page. `items` keeps `parseList`'s
 *  semantics: a row whose status this build does not know DROPS rather than
 *  blanking the customer's whole order history. */
export const DeliveryOrdersPageSchema = z.looseObject({
  items: listOf(DeliveryOrderSchema),
});

/** POST /store/delivery-orders/:id/cancel — the order as it now stands.
 *
 *  Soft all the way down, and that is the point: a 2xx MEANS the cancel
 *  happened, so a drifted body must never false-fail it. A malformed `order`
 *  reads as null (the action then reports the status the backend just
 *  transitioned to), and so does a body that is not an object at all. */
export const CancelDeliverySchema = z
  .looseObject({ order: DeliveryOrderSchema.nullable().catch(null) })
  .catch({ order: null })
  .transform((body) => body.order);

/** Single source of truth for the delivery status union (see the note above). */
export type DeliveryOrderStatus = z.infer<typeof DeliveryOrderSchema>['status'];

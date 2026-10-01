import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import type { ICustomerModuleService } from '@medusajs/framework/types';
import { MedusaError, Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../../modules/packs';
import type PacksModuleService from '../../../../modules/packs/service';
import { CUSTOMER_STATUS_WORD } from '../../../../modules/packs/delivery';
import { serializeDeliveryOrders } from '../../../../modules/packs/delivery-view';
import { reportDb } from '../../sql';

// Delivery order ids are bare 26-character ULIDs.
const FULL_ID = /^[0-9A-Z]{26}$/i;
// What a customer sees: '#' + the order id's last six characters
// (storefront orders page, admin deliveries page).
const NUMBER = /^[0-9A-Z]{6}$/i;

// GET /reports/support/order?number=: a delivery order by the number the
// customer sees (#A1B2C3) or its full id, for the Support desk. Every field is
// copied by name from the order: the shipping address, recipient, phone,
// proof photos and customer id never reach the response (photos are counted,
// because a parcel photo can show the address label). Several orders can share
// a six-character tail, so all matches come back, newest first.
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const raw =
    typeof req.query.number === 'string'
      ? req.query.number.trim().replace(/^#/, '')
      : '';
  const fullId = FULL_ID.test(raw);
  if (!fullId && !NUMBER.test(raw)) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'number must be the 6-character order number the customer sees (like #A1B2C3) or the full order id.',
    );
  }
  const db = reportDb(req);
  const { rows } = await db.raw<{ id: string }>(
    fullId
      ? 'SELECT id FROM delivery_order WHERE deleted_at IS NULL AND id = ?'
      : 'SELECT id FROM delivery_order WHERE deleted_at IS NULL AND upper(right(id, 6)) = upper(?) ORDER BY created_at DESC LIMIT 5',
    [raw],
  );
  if (rows.length === 0) {
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      `No order with number #${raw.slice(-6).toUpperCase()}.`,
    );
  }
  const ids = rows.map((r) => r.id);
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const orders = await packs.listDeliveryOrders(
    { id: ids },
    { take: ids.length, order: { created_at: 'DESC' } },
  );
  const views = new Map(
    (await serializeDeliveryOrders(packs, orders as never)).map((v) => [
      v.id,
      v,
    ]),
  );
  const customers = req.scope.resolve<ICustomerModuleService>(Modules.CUSTOMER);
  const owners = [...new Set(orders.map((o) => o.customer_id))];
  const names = new Map(
    (
      await customers.listCustomers(
        { id: owners },
        { select: ['id', 'first_name'], take: owners.length },
      )
    ).map((c) => [c.id, c.first_name]),
  );
  // Staff status moves (admin_action_audit), read as status pairs only: the
  // free-text reason a staff member typed is never returned.
  const moves = await db.raw<{
    entity_id: string;
    from_status: string | null;
    to_status: string | null;
    at: Date;
  }>(
    "SELECT entity_id, before->>'status' AS from_status, after->>'status' AS to_status, created_at AS at " +
      "FROM admin_action_audit WHERE deleted_at IS NULL AND entity_type = 'delivery_order' " +
      `AND entity_id IN (${ids.map(() => '?').join(', ')}) ORDER BY created_at`,
    ids,
  );
  res.json({
    matches: orders.map((o) => {
      const v = views.get(o.id);
      return {
        number: `#${o.id.slice(-6)}`,
        status: o.status,
        status_word: CUSTOMER_STATUS_WORD[o.status] ?? o.status,
        reward_shipment: Boolean(o.is_reward),
        player: names.get(o.customer_id) ?? null,
        items: (v?.items ?? []).map((i) => ({
          card: i.card?.name ?? null,
          card_handle: i.card?.handle ?? null,
        })),
        tracking_number: o.tracking_number ?? null,
        shipping_fee: v?.shipping_fee ?? null,
        insurance_fee: v?.insurance_fee ?? null,
        requested_at: o.created_at,
        shipped_at: o.shipped_at ?? null,
        completed_at: o.delivered_at ?? null,
        proof_photos: v?.proof_images.length ?? 0,
        status_changes_by_staff: moves.rows
          .filter((m) => m.entity_id === o.id)
          .map((m) => ({ from: m.from_status, to: m.to_status, at: m.at })),
      };
    }),
    note: 'status_word is what the customer sees (completed reads as delivered). A customer can cancel or change the address only while an order is requested or processed. A canceled order with no staff status change was canceled by the customer. The delivery address and phone are never shown here.',
  });
}

import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import type { ICustomerModuleService } from '@medusajs/framework/types';
import { MedusaError, Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../../modules/packs';
import type PacksModuleService from '../../../../modules/packs/service';
import { resolveFxRate } from '../../../../modules/packs/pricing';
import { CUSTOMER_STATUS_WORD } from '../../../../modules/packs/delivery';
import { serializeDeliveryOrders } from '../../../../modules/packs/delivery-view';
import { DEPOSIT_STATUSES } from '../../../../modules/packs/models/gateway-deposit';
import { WITHDRAWAL_STATUSES } from '../../../../modules/packs/models/gateway-withdrawal';
import { findReportPlayer } from '../../player-lookup';
import { and, customerFilter, reportDb, windowFilter } from '../../sql';
import { statusTotals } from '../../finance/queries';

const DAY_MS = 24 * 60 * 60 * 1000;

// GET /reports/support/account?username=: a player's account status for the
// Support desk, by shown name or profile handle (player-lookup.ts). Only the
// username and join date are read from the customer; the flags come from
// playersOverview, never the staff-typed disable/freeze reasons. No email,
// phone, address, bank detail or player group. Every count says whether it is
// lifetime or the last 30 days.
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const { id, lookupNote } = await findReportPlayer(req);
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const customers = req.scope.resolve<ICustomerModuleService>(Modules.CUSTOMER);
  // listCustomers, not retrieveCustomer: a soft-delete between the lookup and
  // this read would otherwise surface Medusa's 'Customer with id cus_...'.
  const [customer] = await customers.listCustomers(
    { id },
    { select: ['id', 'first_name', 'created_at'], take: 1 },
  );
  if (!customer) {
    throw new MedusaError(MedusaError.Types.NOT_FOUND, 'No such player.');
  }
  const overview = await packs.playersOverview(
    [id],
    await resolveFxRate(packs),
  );
  const state = overview.state.get(id);
  const db = reportDb(req);
  const now = Date.now();
  const since = new Date(now - 30 * DAY_MS).toISOString();
  const recent = and(
    windowFilter({ from: since }, 'g.created_at'),
    customerFilter(id, 'g.customer_id'),
  );
  const { rows } = await db.raw<{ n: number }>(
    // Paid pack pulls, like the lifetime count from playersOverview.
    "SELECT count(*)::int AS n FROM pull WHERE deleted_at IS NULL AND source = 'pack' AND customer_id = ? AND rolled_at >= ?::timestamptz",
    [id, since],
  );
  const orders = await packs.listDeliveryOrders(
    { customer_id: id },
    { take: 5, order: { created_at: 'DESC' } },
  );
  const deliveries = await serializeDeliveryOrders(packs, orders);
  res.json({
    username: customer.first_name,
    joined_at: customer.created_at,
    disabled: (await packs.disabledCustomerIds([id])).has(id),
    frozen: state?.frozen ?? false,
    phone_verified: state?.phoneVerified ?? false,
    vip_level: overview.vipLevel.get(id) ?? 0,
    pulls: {
      lifetime: overview.pullCount.get(id) ?? 0,
      last_30_days: Number(rows[0]?.n ?? 0),
    },
    recent_deliveries: deliveries.map((d) => ({
      number: `#${d.id.slice(-6)}`,
      status_word: CUSTOMER_STATUS_WORD[d.status] ?? d.status,
      requested_at: d.created_at,
      item_count: d.items.length,
    })),
    deposits_last_30_days: await statusTotals(
      db,
      'deposits',
      DEPOSIT_STATUSES,
      recent,
    ),
    withdrawals_last_30_days: await statusTotals(
      db,
      'withdrawals',
      WITHDRAWAL_STATUSES,
      recent,
    ),
    last_30_days_window: { from: since, to: new Date(now).toISOString() },
    ...(lookupNote ? { lookup_note: lookupNote } : {}),
    note: 'pulls count paid pack pulls only (no free or prize draws). recent_deliveries is the last 5 orders, newest first; use the order report for one order in full. Payment counts are rows created in the last 30 days, by status (amounts in RM). Disabled also covers deleted accounts.',
  });
}

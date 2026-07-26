import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import PacksModuleService from '../../../../modules/packs/service';
import { PACKS_MODULE } from '../../../../modules/packs';
import { updateDeliveryOrderWorkflow } from '../../../../workflows/update-delivery-order';
import { coerceBulkStatusBody } from '../validate';
import { notifyDeliveryChange } from '../notify';

// A refused transition is what the operator actually reads in the bulk bar's
// skipped list, so it has to survive the trip out of the workflow engine.
// `.run()` rethrows the step error AS SERIALIZED BY the transaction — a plain
// object carrying `message`, not an Error instance — so an `instanceof Error`
// check alone reports every refusal as the useless string "[object Object]".
const failureReason = (err: unknown): string => {
  const message = (err as { message?: unknown } | null | undefined)?.message;
  if (typeof message === 'string' && message.length > 0) return message;
  return typeof err === 'string' ? err : (JSON.stringify(err) ?? String(err));
};

// POST /admin/delivery-orders/bulk — mark up to 100 orders with one status.
// Partial success is the contract: an order that can't legally reach `status`
// is reported in `skipped` with the refusal message and leaves every other id
// untouched. The loop is SEQUENTIAL on purpose — each order's transition runs
// under its own `delivery:<id>` advisory lock inside the service, so there is
// nothing to gain from fanning out, and 100 is the validated ceiling.
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const { ids, status } = coerceBulkStatusBody(req.body);
  const packs: PacksModuleService = req.scope.resolve(PACKS_MODULE);
  const updated: string[] = [];
  const skipped: { id: string; reason: string }[] = [];
  for (const id of ids) {
    const [before] = await packs.listDeliveryOrders({ id }, { take: 1 });
    if (!before) {
      skipped.push({ id, reason: 'not found' });
      continue;
    }
    try {
      const { result } = await updateDeliveryOrderWorkflow(req.scope).run({
        input: { order_id: id, status },
      });
      // Spec acceptance: one audit row per changed order. admin_id is
      // server-derived; reason names the bulk tool.
      await packs.createAdminActionAudits([
        {
          admin_id: req.auth_context.actor_id,
          entity_type: 'delivery_order',
          entity_id: id,
          action: 'bulk_status',
          before: { status: before.status },
          after: { status: result.status },
          reason: `bulk mark as ${status}`,
        },
      ]);
      // Pushed AFTER the audit so `updated` and `skipped` stay disjoint: an
      // audit-write failure lands in the catch below, and an id reported as
      // skipped must never also be reported as updated.
      updated.push(id);
      await notifyDeliveryChange(req.scope, before, result, undefined);
    } catch (err) {
      skipped.push({ id, reason: failureReason(err) });
    }
  }
  res.json({ updated, skipped });
}

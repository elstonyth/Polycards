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
    // One audit row per CHANGED order. updateDeliveryOrderStep short-circuits
    // a same-status update (returns the unchanged status without throwing), so
    // without this guard a select-all "mark processed" on the Processed tab
    // would report 40 updated, change nothing, and leave 40 rows whose before
    // and after are identical in an append-only audit table.
    if (before.status === status) {
      skipped.push({ id, reason: `already ${status}` });
      continue;
    }
    try {
      // Spec acceptance: one audit row per changed order. admin_id is
      // server-derived; reason names the bulk tool. The row is written by the
      // service inside the transaction that moves the status, so an
      // audit-write failure rolls the transition back with it instead of
      // leaving a changed order with no record of who changed it.
      const { result } = await updateDeliveryOrderWorkflow(req.scope).run({
        input: {
          order_id: id,
          status,
          audit: {
            adminId: req.auth_context.actor_id,
            action: 'bulk_status' as const,
            reason: `bulk mark as ${status}`,
          },
        },
      });
      // Pushed only once the workflow (transition AND audit) committed, so
      // `updated` and `skipped` stay disjoint: a failure of either lands in the
      // catch below, and an id reported as skipped must never also be reported
      // as updated.
      updated.push(id);
      await notifyDeliveryChange(req.scope, before, result, undefined);
    } catch (err) {
      skipped.push({ id, reason: failureReason(err) });
    }
  }
  res.json({ updated, skipped });
}

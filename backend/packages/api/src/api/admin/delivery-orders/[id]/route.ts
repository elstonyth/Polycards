import type {
  AuthenticatedMedusaRequest,
  MedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { Modules } from '@medusajs/framework/utils';
import PacksModuleService from '../../../../modules/packs/service';
import { PACKS_MODULE } from '../../../../modules/packs';
import { serializeDeliveryOrders } from '../../../../modules/packs/delivery-view';
import { updateDeliveryOrderWorkflow } from '../../../../workflows/update-delivery-order';
import { coerceDeliveryUpdateBody } from '../validate';
import { notifyDeliveryChange } from '../notify';

export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const packs: PacksModuleService = req.scope.resolve(PACKS_MODULE);
  const { id } = req.params;

  const [order] = await packs.listDeliveryOrders({ id }, { take: 1 });
  if (!order) {
    res.status(404).json({ message: `Delivery order '${id}' not found` });
    return;
  }
  const [serialized] = await serializeDeliveryOrders(packs, [order]);

  const customerService = req.scope.resolve(Modules.CUSTOMER);
  const [customer] = await customerService.listCustomers(
    { id: order.customer_id },
    { take: 1 },
  );

  res.json({
    order: { ...serialized, customer_email: customer?.email ?? null },
  });
}

// POST /admin/delivery-orders/:id — advance status and/or set tracking.
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const { id } = req.params;
  const input = coerceDeliveryUpdateBody(req.body);

  // Read BEFORE the workflow. The workflow result carries only
  // { order_id, status }, and a tracking-only update returns the UNCHANGED
  // status — so both the previous status and the owner have to be captured
  // here to decide whether anything notification-worthy happened.
  const packs: PacksModuleService = req.scope.resolve(PACKS_MODULE);
  const [before] = await packs.listDeliveryOrders({ id }, { take: 1 });

  // Same audit row the bulk route writes, so a Manage-modal transition is as
  // traceable as a bulk-bar one — but written by the service, INSIDE the
  // transaction that moves the status, not here afterwards. Only a real status
  // change reaches that write: a tracking-only update never calls the
  // transition seam at all. 'edit' is the model's generic single-entity action
  // (a new 'status' value would need an enum migration); the reason names the
  // transition, and `input.status` is what it will be (the service refuses
  // rather than lands anything else).
  const { result } = await updateDeliveryOrderWorkflow(req.scope).run({
    input: {
      order_id: id,
      ...input,
      audit: input.status
        ? {
            adminId: req.auth_context.actor_id,
            action: 'edit' as const,
            reason: `mark as ${input.status}`,
          }
        : undefined,
    },
  });

  await notifyDeliveryChange(req.scope, before, result, input.tracking_number);

  res.json(result);
}

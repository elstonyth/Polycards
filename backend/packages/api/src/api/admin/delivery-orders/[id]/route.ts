import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { Modules } from '@medusajs/framework/utils';
import PacksModuleService from '../../../../modules/packs/service';
import { PACKS_MODULE } from '../../../../modules/packs';
import { serializeDeliveryOrders } from '../../../../modules/packs/delivery-view';
import { updateDeliveryOrderWorkflow } from '../../../../workflows/update-delivery-order';
import { coerceDeliveryUpdateBody } from '../validate';

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
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const { id } = req.params;
  const input = coerceDeliveryUpdateBody(req.body);

  const { result } = await updateDeliveryOrderWorkflow(req.scope).run({
    input: { order_id: id, ...input },
  });

  res.json(result);
}

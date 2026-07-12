import {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import PacksModuleService from '../../../modules/packs/service';
import { PACKS_MODULE } from '../../../modules/packs';
import { requestDeliveryWorkflow } from '../../../workflows/request-delivery';
import { serializeDeliveryOrders } from '../../../modules/packs/delivery-view';

const ORDER_LIMIT = 200;
// Mirrors MAX_BATCH in ../vault/buyback-batch/route.ts — a customer can never
// have more vaulted pulls than the vault list returns, so a larger batch is a
// malformed request. Caps the unbounded IN(...) / pull-flip set the workflow
// builds from pull_ids.
const MAX_BATCH = 500;

// POST /store/delivery-orders — request batch delivery of vaulted pulls.
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const customerId = req.auth_context.actor_id;
  const body = req.body as
    | { pull_ids?: unknown; address_id?: unknown }
    | undefined;

  const pullIds = body?.pull_ids;
  const addressId = body?.address_id;
  if (
    !Array.isArray(pullIds) ||
    pullIds.length === 0 ||
    typeof addressId !== 'string' ||
    addressId.trim() === ''
  ) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      '`pull_ids` (string[]) and `address_id` (string) are required.',
    );
  }
  // Cap BEFORE the per-element scan so an oversized array is rejected without
  // a full traversal (plan 018's specified order).
  if (pullIds.length > MAX_BATCH) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `Cannot request delivery of more than ${MAX_BATCH} cards at once.`,
    );
  }
  if (pullIds.some((id) => typeof id !== 'string' || id.trim() === '')) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      '`pull_ids` (string[]) and `address_id` (string) are required.',
    );
  }

  const { result } = await requestDeliveryWorkflow(req.scope).run({
    input: {
      customer_id: customerId,
      pull_ids: pullIds as string[],
      address_id: addressId,
    },
  });

  res.status(201).json(result);
}

// GET /store/delivery-orders — the caller's delivery orders, newest first.
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const customerId = req.auth_context.actor_id;
  const packs: PacksModuleService = req.scope.resolve(PACKS_MODULE);

  const orders = await packs.listDeliveryOrders(
    { customer_id: customerId },
    { order: { created_at: 'DESC' }, take: ORDER_LIMIT },
  );

  const items = await serializeDeliveryOrders(packs, orders);
  res.json({ items });
}

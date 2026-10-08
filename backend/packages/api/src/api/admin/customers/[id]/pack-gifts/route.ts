import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError, Modules } from '@medusajs/framework/utils';
import type { ICustomerModuleService } from '@medusajs/framework/types';
import { PACKS_MODULE } from '../../../../../modules/packs';
import type PacksModuleService from '../../../../../modules/packs/service';
import { notifyFeedNonfatal } from '../../../../../modules/packs/notify-feed';

// GET  /admin/customers/:id/pack-gifts — every gift granted, newest first.
// POST /admin/customers/:id/pack-gifts — gift N of one pack (spec 2026-10-07
//      §7). Body { pack_id (slug), quantity 1–10, note, idempotency_key }.
//      Rules (giftable pack, quantity, note, idempotency, the daily mint
//      ceiling) live in PacksModuleService.grantPackGifts. admin_id comes from
//      the session, never the body. Admin routes are auto-protected; POST
//      shares the admin money-mutation rate limit (middlewares.ts).

type Body = {
  pack_id?: unknown;
  quantity?: unknown;
  note?: unknown;
  idempotency_key?: unknown;
};

async function assertCustomer(
  req: AuthenticatedMedusaRequest,
  id: string,
): Promise<void> {
  const customers = req.scope.resolve<ICustomerModuleService>(Modules.CUSTOMER);
  const [customer] = await customers.listCustomers({ id }, { take: 1 });
  if (!customer) {
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      `Customer '${id}' not found`,
    );
  }
}

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const { id } = req.params;
  await assertCustomer(req, id);
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  res.json({ gifts: await packs.listPackGiftsForCustomer(id) });
}

export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const { id } = req.params;
  await assertCustomer(req, id);
  const body = (req.body ?? {}) as Body;
  if (typeof body.pack_id !== 'string' || body.pack_id.trim() === '') {
    throw new MedusaError(MedusaError.Types.INVALID_DATA, 'Choose a pack.');
  }
  if (
    typeof body.idempotency_key !== 'string' ||
    !body.idempotency_key.trim() ||
    body.idempotency_key.length > 200
  ) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'Request ID must be a non-empty string of at most 200 characters.',
    );
  }

  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const { gifts, replayed, packTitle } = await packs.grantPackGifts({
    customerId: id,
    packSlug: body.pack_id.trim(),
    quantity: body.quantity,
    note: body.note,
    adminId: req.auth_context.actor_id,
    idempotencyKey: body.idempotency_key.trim(),
  });

  // Post-commit: tell the customer (once per grant — keyed on the grant).
  if (!replayed && gifts.length > 0) {
    await notifyFeedNonfatal(req.scope, 'pack-gift', {
      receiverId: id,
      template: 'pack_gift_received',
      data: {
        pack_id: gifts[0].pack_id,
        title: packTitle,
        quantity: gifts.length,
      },
      idempotencyKey: `pack-gift:${gifts[0].grant_key}`,
    });
  }

  res.status(201).json({ gifts });
}

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError, Modules } from '@medusajs/framework/utils';
import type { ICustomerModuleService } from '@medusajs/framework/types';
import { PACKS_MODULE } from '../../../../../modules/packs';
import type PacksModuleService from '../../../../../modules/packs/service';

type Body = {
  tickets?: unknown;
  note?: unknown;
  idempotency_key?: unknown;
};

// POST /admin/customers/:id/lucky-draw-tickets — give (positive) or take back
// (negative) a customer's Lucky Draw tickets (operator 2026-10-25). The admin
// group editor calls it once per member, with a per-member idempotency key, the
// way it does /credits. admin_id comes from auth_context, never the body. The
// rules (amount, note, floor, replay) live in adjustLuckyDrawTickets.
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const { id } = req.params;
  const customerService: ICustomerModuleService = req.scope.resolve(
    Modules.CUSTOMER,
  );
  const [customer] = await customerService.listCustomers({ id }, { take: 1 });
  if (!customer) {
    res.status(404).json({ message: `Customer '${id}' not found` });
    return;
  }

  const body = (req.body ?? {}) as Body;
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  try {
    const result = await packs.adjustLuckyDrawTickets({
      customerId: id,
      tickets: body.tickets,
      note: body.note,
      adminId: req.auth_context.actor_id,
      idempotencyKey: body.idempotency_key,
    });
    res.json({ tickets: result.tickets, balance: result.balance });
  } catch (e) {
    // Answered here: the global handler swaps any CONFLICT message for a
    // generic idempotency text.
    if (e instanceof MedusaError && e.type === MedusaError.Types.CONFLICT) {
      res.status(409).json({ message: e.message });
      return;
    }
    throw e;
  }
}

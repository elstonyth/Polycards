import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import { Modules } from "@medusajs/framework/utils";
import type { ICustomerModuleService } from "@medusajs/framework/types";
import { adjustCreditsWorkflow } from "../../../../../workflows/adjust-credits";

type Body = { amount?: unknown; note?: unknown; idempotency_key?: unknown };

// POST /admin/customers/:id/credits — operator credit adjustment (grant /
// refund / clawback). One signed ledger row, RM 0 balance floor; amount/note
// rules live in the workflow step (modules/packs/credit-adjust.ts). Admin
// routes are auto-protected — no middleware entry needed.
// admin_id is derived server-side from auth_context.actor_id and is NEVER
// taken from the request body, preventing client-side impersonation.
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

  const adminId = req.auth_context.actor_id;
  const body = (req.body ?? {}) as Body;
  const { result } = await adjustCreditsWorkflow(req.scope).run({
    input: {
      customer_id: id,
      amount: body.amount,
      note: body.note,
      admin_id: adminId,
      idempotency_key: body.idempotency_key,
    },
  });

  res.json({ amount: result.amount, balance: result.balance });
}

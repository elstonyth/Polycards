import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../../modules/packs';
import type PacksModuleService from '../../../../modules/packs/service';

const HISTORY_ROWS = 200;

// GET /admin/lucky-draw/tickets?customer_id= — a customer's ticket balance and
// their newest ledger rows, for support.
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const customerId = req.query.customer_id;
  if (typeof customerId !== 'string' || customerId === '') {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'customer_id is required.',
    );
  }
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  res.json(await packs.luckyDrawTicketHistory(customerId, HISTORY_ROWS));
}

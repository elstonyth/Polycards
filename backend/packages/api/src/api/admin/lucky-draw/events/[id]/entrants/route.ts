import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../../../../modules/packs';
import type PacksModuleService from '../../../../../../modules/packs/service';
import { aggregateEntries } from '../../../../../../modules/packs/lucky-draw';
import pageAll from '../../../../../utils/page-all';

// GET /admin/lucky-draw/events/:id/entrants — who entered a one_winner event, one
// row per customer with their total tickets, most tickets first.
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const { id } = req.params;
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const [event] = await packs.listLuckyDrawEvents({ id }, { take: 1 });
  if (!event) {
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      'Lucky Draw event not found.',
    );
  }
  const rows = await pageAll((opts) =>
    packs.listLuckyDrawEntries({ event_id: id }, opts),
  );
  // aggregateEntries sorts by customer id; the sort below is stable, so
  // equal totals stay in that order.
  const entries = aggregateEntries(rows).sort((a, b) => b.tickets - a.tickets);
  res.json({ entries });
}

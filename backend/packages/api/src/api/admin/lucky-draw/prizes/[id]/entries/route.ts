import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../../../../modules/packs';
import type PacksModuleService from '../../../../../../modules/packs/service';
import { aggregateEntries } from '../../../../../../modules/packs/lucky-draw';
import pageAll from '../../../../../utils/page-all';

// GET /admin/lucky-draw/prizes/:id/entries — who entered, one row per
// customer with their total tickets, most tickets first.
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const { id } = req.params;
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const [prize] = await packs.listLuckyDrawPrizes({ id }, { take: 1 });
  if (!prize) {
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      'Lucky Draw prize not found.',
    );
  }
  const rows = await pageAll((opts) =>
    packs.listLuckyDrawEntries({ prize_id: id }, opts),
  );
  // aggregateEntries sorts by customer id; the sort below is stable, so
  // equal totals stay in that order.
  const entries = aggregateEntries(rows).sort((a, b) => b.tickets - a.tickets);
  res.json({ entries });
}

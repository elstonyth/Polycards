import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../../modules/packs';
import type PacksModuleService from '../../../../modules/packs/service';
import { resultViewsFor } from '../view';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

const bad = (message: string): never => {
  throw new MedusaError(MedusaError.Types.INVALID_DATA, message);
};

// GET /store/lucky-draw/results?before=<iso>&limit=<1..50> — drawn prizes
// across every event, newest draw first. `next_before` is the cursor for the
// next page (null on the last).
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  if (!req.auth_context?.actor_id) {
    throw new MedusaError(MedusaError.Types.UNAUTHORIZED, 'Unauthorized');
  }
  const { limit: rawLimit, before: rawBefore } = req.query;

  let limit = DEFAULT_LIMIT;
  if (rawLimit !== undefined) {
    if (typeof rawLimit !== 'string' || !/^\d+$/.test(rawLimit)) {
      bad('limit must be a whole number');
    }
    limit = Number(rawLimit);
    if (limit < 1 || limit > MAX_LIMIT) {
      bad(`limit must be between 1 and ${MAX_LIMIT}`);
    }
  }
  let before: Date | null = null;
  if (rawBefore !== undefined) {
    before = typeof rawBefore === 'string' ? new Date(rawBefore) : null;
    if (!before || Number.isNaN(before.getTime())) {
      bad('before must be an ISO date');
    }
  }

  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const page = await packs.luckyDrawResultPage({ before, limit });
  res.json({
    results: await resultViewsFor(req, packs, page.prizeIds),
    next_before: page.nextBefore,
  });
}

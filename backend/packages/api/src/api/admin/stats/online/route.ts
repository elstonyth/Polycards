import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../../modules/packs';
import type PacksModuleService from '../../../../modules/packs/service';
import { parseScope } from '../../../../modules/packs/real-customers';
import {
  ONLINE_WINDOW_MS,
  presenceStore,
} from '../../../utils/presence';

/**
 * GET /admin/stats/online?scope=default|all: players whose storefront pinged
 * POST /store/presence in the last 5 minutes. `default` counts real customers
 * only (real-customers.ts), like the rest of the Dashboard under its switch.
 * `online` is null when the presence store cannot be read: the Dashboard
 * shows "—", never a 0 that looks like an empty site.
 */
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const scope = parseScope(req.query.scope, 'all');
  if (!scope) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'scope must be default or all.',
    );
  }
  const now = Date.now();
  let ids: string[] | null;
  try {
    ids = await presenceStore().seenSince(now - ONLINE_WINDOW_MS);
  } catch {
    ids = null;
  }
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const online =
    ids === null
      ? null
      : scope === 'all'
        ? ids.length
        : await packs.realCustomerCount(ids);
  res.json({
    as_of: new Date(now),
    scope,
    window_minutes: ONLINE_WINDOW_MS / 60_000,
    online,
  });
}

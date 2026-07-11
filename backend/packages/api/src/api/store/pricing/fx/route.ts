import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import PacksModuleService from '../../../../modules/packs/service';
import { PACKS_MODULE } from '../../../../modules/packs';
import { resolveFxRateInfo } from '../../../../modules/packs/pricing';

// GET /store/pricing/fx — the current effective USD->MYR rate. Public,
// read-only, no customer auth (a currency rate carries no PII) — mirrors
// admin/pricing/fx's GET but store-scoped and trimmed to the one field the
// storefront needs to compute a display price client-of-Mercur-data
// (the marketplace listing reads Mercur products directly, so it resolves
// this rate itself rather than a store route enriching the price server-side).
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const packs: PacksModuleService = req.scope.resolve(PACKS_MODULE);
  // firm:false = `rate` is the display fallback (no usable FxRate row) — fine
  // for showing prices, but money writes will refuse, so clients must not
  // treat fallback pricing as transactable (sim finding P1-1).
  const { rate, firm } = await resolveFxRateInfo(packs);
  res.json({ rate, firm });
}

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import {
  resolvePacks,
  type GatewayReports,
} from '../../../../modules/packs/facets';
import { moneyIntegrityFindings } from '../../../../modules/packs/money-integrity';

// GET /admin/payments/integrity — money a crash left half-moved, read fresh.
// Read-only. Admin-only, on the payment:read every /admin/payments GET asks.
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    findings: await moneyIntegrityFindings(
      resolvePacks<GatewayReports>(req.scope),
    ),
  });
}

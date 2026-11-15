import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import {
  resolvePacks,
  type GatewayReports,
} from '../../../../modules/packs/facets';
import { moneyIntegrityFindings } from '../../../../modules/packs/money-integrity';
import { wireDate } from '../../../utils/wire-date';
import type { MoneyIntegrity } from './types';

// GET /admin/payments/integrity — money a crash left half-moved, read fresh.
// Read-only. Admin-only, on the payment:read every /admin/payments GET asks.
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse<MoneyIntegrity>,
): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  const findings = await moneyIntegrityFindings(
    resolvePacks<GatewayReports>(req.scope),
  );
  res.json({ findings: findings.map((f) => ({ ...f, at: wireDate(f.at) })) });
}

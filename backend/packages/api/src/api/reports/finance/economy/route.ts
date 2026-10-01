import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { PACKS_MODULE } from '../../../../modules/packs';
import type PacksModuleService from '../../../../modules/packs/service';
import { resolveFxRate } from '../../../../modules/packs/pricing';
import { describeScope, loadGroupScope, parseWindow } from '../../params';
import { and, reportDb, scopeFilter, windowFilter } from '../../sql';
import { ledgerTotalsWhere } from '../queries';

// GET /reports/finance/economy: the Finance desk's Economy page. Ledger
// totals for a window and player group, plus the current liabilities (all
// players; a snapshot, never scoped). Same ledgerTotals fold and liability
// methods as GET /admin/economy.
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const window = parseWindow(req.query);
  const scope = await loadGroupScope(req);
  const totals = await ledgerTotalsWhere(
    reportDb(req),
    and(
      windowFilter(window, 'ct.created_at'),
      scopeFilter(scope, 'ct.customer_id'),
    ),
  );
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const vault = await packs.vaultLiabilityMyr(await resolveFxRate(packs));
  res.json({
    currency: 'MYR',
    window: { from: window.from ?? null, to: window.to ?? null },
    scope: describeScope(scope),
    totals,
    liability_now_all_players: {
      vault_cards: vault.count,
      vault_value: vault.liability,
      outstanding_vouchers: await packs.outstandingVoucherLiabilityMyr(),
    },
  });
}

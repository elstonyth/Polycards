import type { AuthenticatedMedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../../modules/packs';
import type PacksModuleService from '../../../../modules/packs/service';
import { assertCoinFlipEligible } from '../../../../modules/packs/coin-flip';
import { resolveGroupPolicyForCustomer } from '../../../../modules/packs/group-policy';

export async function GET(req: AuthenticatedMedusaRequest, res: MedusaResponse): Promise<void> {
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const [config, wallet, group] = await Promise.all([packs.coinFlipSettings(), packs.walletSummary(req.auth_context.actor_id), resolveGroupPolicyForCustomer(req.scope, req.auth_context.actor_id)]);
  let reason: string | null = config.enabled ? null : 'Coin flip is currently paused.';
  if (config.enabled) {
    try { assertCoinFlipEligible(wallet, group?.policy.withdrawals_blocked === true); }
    catch (error) {
      if (!(error instanceof MedusaError)) throw error;
      reason = error.message;
    }
  }
  res.json({ enabled: config.enabled,
    published_win_percent: config.published_win_percent, eligible: reason === null, reason });
}

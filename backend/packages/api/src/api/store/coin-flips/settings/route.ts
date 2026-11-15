import type { AuthenticatedMedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { PACKS_MODULE } from '../../../../modules/packs';
import type PacksModuleService from '../../../../modules/packs/service';
import { COIN_FLIP_REFUSAL } from '../../../../modules/packs/eligibility';

export async function GET(req: AuthenticatedMedusaRequest, res: MedusaResponse): Promise<void> {
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  // The quote's own gate, so the page and the flip never disagree.
  const [config, refusal] = await Promise.all([packs.coinFlipSettings(), packs.mayPlay(req.auth_context.actor_id, 'coin_flip')]);
  const reason = !config.enabled ? 'Coin flip is currently paused.' : refusal ? COIN_FLIP_REFUSAL[refusal] : null;
  res.json({ enabled: config.enabled,
    published_win_percent: config.published_win_percent, eligible: reason === null, reason });
}

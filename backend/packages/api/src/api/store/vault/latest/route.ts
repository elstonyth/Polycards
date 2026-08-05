import {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import PacksModuleService from '../../../../modules/packs/service';
import { PACKS_MODULE } from '../../../../modules/packs';

// GET /store/vault/latest — the newest vault-visible event for the caller.
//
// Feeds the Vault tab's unread dot: the client compares this stamp against its
// own last-seen value and shows a dot when this one is newer. Deliberately NOT
// folded into GET /store/vault — the dot is read from every page, and must not
// pay for a 500-item vault list.
//
// The `status: 'vaulted'` filter is the whole design. Events that should light
// the dot (a new pull, a canceled delivery returning its cards) bump
// updated_at on a row INSIDE the filter; departures the customer initiated
// themselves (ship-out → 'delivering', sell-back → 'bought_back') bump a row
// that has just left it, so they stay silent. No extra column, no workflow
// edits. See docs/superpowers/specs/2026-08-05-vault-red-dot-design.md.
//
// AUTH: matcher registered in src/api/middlewares.ts with authenticate(); the
// customer id comes ONLY from the verified token, so a caller can never probe
// another customer's vault activity.
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const packs: PacksModuleService = req.scope.resolve(PACKS_MODULE);

  // No new index needed: IDX_pull_customer_id_rolled_at seeks on customer_id,
  // and VAULT_LIMIT caps a customer at 500 rows, so the residual sort is trivial.
  const [newest] = await packs.listPulls(
    { customer_id: req.auth_context.actor_id, status: 'vaulted' },
    { order: { updated_at: 'DESC' }, take: 1 },
  );

  res.json({ latest_event_at: newest?.updated_at ?? null });
}

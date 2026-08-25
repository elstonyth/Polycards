import {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import PacksModuleService from '../../../../modules/packs/service';
import { PACKS_MODULE } from '../../../../modules/packs';

// GET /store/credits/latest — the newest balance movement for the caller.
//
// Feeds the Me tab's money dot: the client compares this stamp against its own
// last-seen value and shows a dot when this one is newer. Deliberately NOT
// folded into GET /store/credits — the dot is read from every page, and must
// not pay for the full wallet view and its transaction page.
//
// EVERY credit_transaction counts, not just money in. The ledger row IS the
// event the customer goes to /transactions to read: a sell-back, a top-up, a
// withdrawal, a reward credit, a pack-open charge. Filtering to
// credits only would silently drop the debits people most want to verify.
//
// created_at, not updated_at: a ledger row is append-only, and a later
// bookkeeping touch is not a new thing for the customer to look at.
//
// AUTH: matcher registered in src/api/middlewares.ts with authenticate(); the
// customer id comes ONLY from the verified token, so a caller can never probe
// another customer's balance activity.
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const packs: PacksModuleService = req.scope.resolve(PACKS_MODULE);

  const [newest] = await packs.listCreditTransactions(
    { customer_id: req.auth_context.actor_id },
    { order: { created_at: 'DESC' }, take: 1 },
  );

  // Cache-Control: no-store is applied to every authenticated /store response
  // by noStoreForAuthenticatedStore (src/api/middlewares.ts, blanket matcher).
  res.json({ latest_event_at: newest?.created_at ?? null });
}

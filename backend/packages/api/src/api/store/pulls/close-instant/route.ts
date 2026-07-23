import {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import { PACKS_MODULE } from "../../../../modules/packs";
import type PacksModuleService from "../../../../modules/packs/service";

// POST /store/pulls/close-instant — end the instant-buyback window for the
// caller's own pulls. The reveal client calls this when the reveal component
// unmounts (concluding via "Spin again", or in-app navigation away), so from
// then on the vault and every later sell quote the flat rate, even inside the
// 30s. A HARD exit (tab close, app kill) can't run the client, so it falls back
// to the 30s time deadline — the accepted backstop, not instant coverage. CLOSE-
// ONLY + owner-scoped + idempotent (see closeInstantWindow): it can never
// re-open the premium, so a replayed or spoofed call is harmless.
//
// AUTH + RATE LIMIT: registered in src/api/middlewares.ts. The customer id
// comes ONLY from the verified token; ownership is enforced in the service.
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const customerId = req.auth_context.actor_id;
  const body = (req.body ?? {}) as { pull_ids?: unknown };
  const pullIds = Array.isArray(body.pull_ids)
    ? body.pull_ids.filter((x): x is string => typeof x === "string")
    : [];
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const result = await packs.closeInstantWindow(pullIds, customerId);
  res.json(result);
}

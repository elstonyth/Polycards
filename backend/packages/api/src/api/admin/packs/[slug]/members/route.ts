import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import PacksModuleService from "../../../../../modules/packs/service";
import { PACKS_MODULE } from "../../../../../modules/packs";
import { setPackMembersWorkflow } from "../../../../../workflows/set-pack-members";
import { clearPackDetailCache } from "../../../../store/packs/[slug]/route";

// GET /admin/packs/:slug/members — the card handles currently in the pack's
// prize pool (one per PackOdds row). The card-picker loads the full catalog from
// GET /admin/cards separately.
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const packs: PacksModuleService = req.scope.resolve(PACKS_MODULE);
  const { slug } = req.params;

  const odds = await packs.listPackOdds({ pack_id: slug }, { take: 1000 });
  res.json({ members: odds.map((o) => o.card_id) });
}

type Body = { card_ids?: unknown };

// POST /admin/packs/:slug/members — set the pack's full membership. The workflow
// diffs against the current pool (adds new even-weighted rows, removes dropped
// cards, keeps shared rows' tuned weights). Win rates are then tuned separately.
export async function POST(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const { slug } = req.params;
  const body = (req.body ?? {}) as Body;

  if (!Array.isArray(body.card_ids)) {
    res.status(400).json({ message: "Body must include a `card_ids` array." });
    return;
  }
  const card_ids = body.card_ids.filter(
    (x): x is string => typeof x === "string"
  );

  const { result } = await setPackMembersWorkflow(req.scope).run({
    input: { pack_id: slug, card_ids },
  });
  // Membership IS the pack's prize pool — the exact Pokémon the reel shows and
  // the Top-Hit candidates. Bust the 30s storefront detail cache so a pool edit
  // reflects immediately (matches the sibling odds/top-hits routes).
  clearPackDetailCache();
  res.json(result);
}

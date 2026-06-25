import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { PACKS_MODULE } from '../../../../modules/packs';
import type PacksModuleService from '../../../../modules/packs/service';
import { validateRewardPool } from '../../../../modules/packs/reward-pool-validate';
import { saveRewardPoolWorkflow } from '../../../../workflows/save-reward-pool';

// GET /admin/reward-pools/:tier — current pool config + entries for a VIP tier.
//
// Returns the reward_box Pack config (draws_per_day, pool_enabled) and all its
// reward PackOdds rows (card_id null). When the Pack does not exist yet, returns
// 200 with an empty body shape ({ pool: null, entries: [] }) — not a 404 — so the
// admin UI can distinguish "never authored" from a real error.
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const { tier } = req.params;
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);

  const slug = `reward-box-${tier}`;
  const [pack] = await packs.listPacks({ slug }, { take: 1 });
  if (!pack) {
    // Pool not yet authored — return empty rather than 404 so the admin UI
    // can distinguish "never created" from "does not exist".
    res.json({ pool: null, entries: [] });
    return;
  }

  // Only reward rows (card_id null) belong to the reward pool editor.
  const allOdds = await packs.listPackOdds({ pack_id: slug }, { take: 10000 });
  const entries = allOdds
    .filter((o) => o.card_id == null)
    .map((o) => ({
      id: o.id,
      kind: o.kind,
      product_handle: o.product_handle ?? null,
      // credit_amount is bigNumber — Number() converts the raw_credit_amount decimal
      credit_amount: o.credit_amount != null ? Number(o.credit_amount) : null,
      weight: o.weight,
    }));

  res.json({
    pool: {
      slug: pack.slug,
      pool_enabled: pack.pool_enabled,
      draws_per_day: pack.draws_per_day,
      status: pack.status,
    },
    entries,
  });
}

// POST /admin/reward-pools/:tier — replace-all the tier's reward pool entries.
//
// Body: { entries:[{kind, product_handle?, credit_amount?, weight}],
//         draws_per_day, pool_enabled }
// admin_id is derived from auth_context — NEVER from the body.
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const { tier } = req.params;
  const adminId = req.auth_context.actor_id;

  // Validate throws MedusaError(INVALID_DATA) on bad input → 400.
  const body = validateRewardPool(req.body);

  const { result } = await saveRewardPoolWorkflow(req.scope).run({
    input: {
      tier,
      entries: body.entries,
      draws_per_day: body.draws_per_day,
      pool_enabled: body.pool_enabled,
      admin_id: adminId,
    },
  });

  res.status(200).json({ pool: result });
}

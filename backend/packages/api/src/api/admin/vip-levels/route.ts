import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { PACKS_MODULE } from '../../../modules/packs';
import type PacksModuleService from '../../../modules/packs/service';
import { validateVipLevels } from '../../../modules/packs/vip-levels-validate';
import { reqReason } from '../rewards-settings/validate';

// GET /admin/vip-levels — the full ladder ordered by level (Levels tab load).
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const rows = await packs.listVipLevels(
    {},
    {
      select: [
        'level',
        'spend_threshold',
        'voucher_amount',
        'box_tier',
        'frame_unlock',
        'direct_referral_pct',
      ],
      take: 1000,
    },
  );
  const levels = rows
    .map((r) => ({
      level: r.level,
      spend_threshold: Number(r.spend_threshold),
      voucher_amount: Number(r.voucher_amount),
      box_tier: r.box_tier,
      frame_unlock: r.frame_unlock,
      direct_referral_pct: r.direct_referral_pct,
    }))
    .sort((a, b) => a.level - b.level);
  res.json({ levels });
}

// POST /admin/vip-levels — audited whole-ladder replace. admin_id derives from
// the verified auth_context (NEVER the body); /admin/* is auto-protected.
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const adminId = req.auth_context.actor_id;
  const reason = reqReason(req.body);
  const levels = validateVipLevels(req.body);
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const saved = await packs.saveVipLevels({ levels, adminId, reason });
  res.json({ levels: saved });
}

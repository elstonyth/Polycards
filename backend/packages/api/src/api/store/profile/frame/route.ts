import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError, Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../../modules/packs';
import type PacksModuleService from '../../../../modules/packs/service';

// POST /store/profile/frame { level: 10..100 | null } — equip (level) or
// unequip (null) an avatar frame. Frames exist only at milestone levels
// (workbook '^': every 10th level) and unlock when highest_level_ever ≥
// level; the catalog must actually carry an image for that level. Writes
// customer.metadata.equipped_frame_level (merged — see the avatar route's
// note on reserved metadata keys). Levels never decrease (cumulative spend),
// so an equipped frame can't silently re-lock.
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const customerId = req.auth_context?.actor_id;
  if (!customerId) {
    throw new MedusaError(MedusaError.Types.UNAUTHORIZED, 'Unauthorized');
  }

  const raw = (req.body as { level?: unknown } | null)?.level;
  let level: number | null = null;
  if (raw !== null && raw !== undefined) {
    level = Number(raw);
    if (
      !Number.isInteger(level) ||
      level < 10 ||
      level > 100 ||
      level % 10 !== 0
    ) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        'level must be null or a milestone level (10, 20, … 100).',
      );
    }
  }

  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  if (level !== null) {
    const [state] = await packs.listVipMemberStates(
      { customer_id: customerId },
      { take: 1 },
    );
    const highest = state ? Number(state.highest_level_ever) : 1;
    if (highest < level) {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        `Frame LV ${level} unlocks at level ${level}.`,
      );
    }
    const { avatar_frames } = await packs.siteSettings();
    if (!avatar_frames[String(level)]) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `No frame image is configured for LV ${level} yet.`,
      );
    }
  }

  const customers = req.scope.resolve(Modules.CUSTOMER);
  const customer = await customers.retrieveCustomer(customerId);
  await customers.updateCustomers(customerId, {
    metadata: { ...(customer.metadata ?? {}), equipped_frame_level: level },
  });

  res.json({ equipped_frame_level: level });
}

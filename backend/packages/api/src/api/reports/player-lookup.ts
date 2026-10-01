import type { MedusaRequest } from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../modules/packs';
import type PacksModuleService from '../../modules/packs/service';
import { isValidUsername } from '../../utils/profile-handle';

/**
 * The player a desk report is about, from ?username=. Staff may have the
 * shown name or the permanent profile handle from a /profile/<handle> link
 * (utils/profile-handle.ts). The two are separate namespaces, so one string
 * can name two players: the shown name wins and lookupNote says the handle
 * belongs to someone else. 400 for a malformed value, 404 for nobody.
 */
export async function findReportPlayer(
  req: MedusaRequest,
): Promise<{ id: string; lookupNote?: string }> {
  const raw = req.query.username;
  if (!isValidUsername(raw)) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'username must be 3-30 letters, digits, _ or -.',
    );
  }
  const username = raw.trim();
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const byName = await packs.findCustomerIdByUsername(username);
  const byHandle = await packs.findCustomerIdByHandle(username);
  const id = byName ?? byHandle;
  if (!id) {
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      `No player with username or profile handle ${username}.`,
    );
  }
  return byName && byHandle && byHandle !== byName
    ? {
        id,
        lookupNote: `${username} is also the profile handle of a different player. To report on that player, use the name shown on their profile.`,
      }
    : { id };
}

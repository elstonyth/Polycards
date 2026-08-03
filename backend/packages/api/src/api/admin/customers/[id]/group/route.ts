import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { setPlayerGroup } from '../../../../../modules/packs/player-groups';

type Body = { group_id?: unknown };

/**
 * POST /admin/customers/:id/group — move a player into ONE player group.
 *
 * A single call on purpose. Medusa's native route is group-scoped
 * (POST /admin/customer-groups/:id/customers), so a move from A to B is two
 * requests from the dashboard, and a failure between them leaves the player in
 * both — where the older group's odds silently win. Doing it server-side keeps
 * "a player has one group" true after every operator click.
 *
 * Body: `{ group_id: string | null }`. null (or omitted) means the default
 * group, never "no group". Admin routes are framework-auto-protected.
 */
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const customerId = req.params.id;
  const raw = (req.body as Body)?.group_id;
  if (raw !== undefined && raw !== null && typeof raw !== 'string') {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'group_id must be a string or null.',
    );
  }
  const groupId =
    typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null;

  const group = await setPlayerGroup(req.scope, customerId, groupId);
  res.json({ group: { id: group.id, name: group.name } });
}

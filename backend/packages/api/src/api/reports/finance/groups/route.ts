import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import type { ICustomerModuleService } from '@medusajs/framework/types';
import { Modules } from '@medusajs/framework/utils';
import { isDefaultPlayerGroup } from '../../../../modules/packs/odds-sets';
import { reportDb } from '../../sql';
import { groupSizes } from '../queries';

// GET /reports/finance/groups: the player groups a ?group= scope can name,
// with how many players each holds now by EFFECTIVE group. default_players
// counts everyone in no group other than DEFAULT.
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const customers = req.scope.resolve<ICustomerModuleService>(Modules.CUSTOMER);
  const groups = await customers.listCustomerGroups(
    {},
    { take: 100, order: { created_at: 'ASC' } },
  );
  const { defaultPlayers, byGroup } = await groupSizes(reportDb(req));
  res.json({
    default_players: defaultPlayers,
    groups: groups
      .filter((g) => !isDefaultPlayerGroup(g))
      .map((g) => ({ name: g.name, players: byGroup.get(g.id) ?? 0 })),
  });
}

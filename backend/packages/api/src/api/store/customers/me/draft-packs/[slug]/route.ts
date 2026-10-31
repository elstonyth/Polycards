import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../../../../modules/packs';
import { customerSeesDrafts } from '../../../../../../modules/packs/group-policy';
import type PacksModuleService from '../../../../../../modules/packs/service';
import { packDetailBody } from '../../../../packs/pack-bodies';
import { HIDDEN_CATEGORIES } from '../route';

// GET /store/customers/me/draft-packs/:slug — one Draft pack, in the shape of
// GET /store/packs/:slug, for a member of a group that can see Drafts. Everyone
// else gets the 404 that route gives an unknown pack. Never cached, for the reason
// on the list route. Holds no draw weight, as the public body doesn't.
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const customerId = req.auth_context?.actor_id;
  if (!customerId) {
    throw new MedusaError(MedusaError.Types.UNAUTHORIZED, 'Unauthorized');
  }
  res.setHeader('Cache-Control', 'private, no-store');
  const { slug } = req.params;
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const [pack] = (await customerSeesDrafts(req.scope, customerId))
    ? await packs.listPacks({ slug, status: 'draft' }, { take: 1 })
    : [];
  if (!pack || HIDDEN_CATEGORIES.includes(pack.category)) {
    res.status(404).json({ message: `Pack '${slug}' not found` });
    return;
  }
  res.json(await packDetailBody(packs, pack));
}

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../../../modules/packs';
import { FREE_WELCOME_CATEGORY } from '../../../../../modules/packs/free-pack';
import { customerSeesDrafts } from '../../../../../modules/packs/group-policy';
import type PacksModuleService from '../../../../../modules/packs/service';
import { catalogRows } from '../../../packs/pack-bodies';

/** Never shown, draft or not: internal draw pools and the claim-only free pack. */
export const HIDDEN_CATEGORIES = ['reward_box', FREE_WELCOME_CATEGORY];

// GET /store/customers/me/draft-packs — Draft packs, in the catalog's row shape,
// for a member of a group that can see them (group-policy.ts). A non-member gets
// an empty list, not a refusal, so the answer says nothing about the feature.
//
// Separate from GET /store/packs on purpose: that route caches one body for every
// viewer, so a draft in it would reach every customer. Nothing here is cached, on
// the server or in a browser.
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const customerId = req.auth_context?.actor_id;
  if (!customerId) {
    throw new MedusaError(MedusaError.Types.UNAUTHORIZED, 'Unauthorized');
  }
  res.setHeader('Cache-Control', 'private, no-store');
  if (!(await customerSeesDrafts(req.scope, customerId))) {
    res.json({ packs: [] });
    return;
  }
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const drafts = await packs.listPacks(
    {
      status: 'draft',
      category: { $nin: HIDDEN_CATEGORIES },
    } as Parameters<typeof packs.listPacks>[0],
    { order: { category: 'ASC', rank: 'ASC' }, take: 500 },
  );
  res.json({ packs: await catalogRows(packs, drafts) });
}

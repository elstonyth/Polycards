import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { mintSuperAdmin, postStoreCustomer, unwrapResponse } from './utils';

/**
 * GET /admin/customers/:id/referral-tree — the downward walk (#432).
 *
 * c7447424 deleted the original referral-tree spec along with the retired
 * referral WRITE paths, but referralTreeFor still serves this route.
 * customer-360.spec.ts replaced only the shallow root+2 case; everything the
 * CTE actually owns went with the deletion and is restored here:
 *
 *  - DOWN, never up: the join is r.sponsor_id = t.node_id, the opposite of the
 *    two upward CTEs in the same file. An ancestor appearing in `nodes` is the
 *    failure this guards.
 *  - depth truncation + has_more_depth: the "there is more below this cut" flag
 *    is the only thing telling the admin UI a subtree was clipped.
 *  - direct_recruit_count per node.
 *  - soft-delete pruning: every leg filters deleted_at IS NULL.
 *
 * Seeded with the same three-line createReferralRelationships([...]) six other
 * specs already use — the writes are retired, the model is not.
 */

jest.setTimeout(240 * 1000);
const PASSWORD = 'referral-tree-pw-1'; // gitleaks:allow

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    let storeHeaders: Record<string, string>;
    let adminToken: string;

    beforeEach(async () => {
      const container = getContainer();
      const apiKey = container.resolve(Modules.API_KEY);
      const key = await apiKey.createApiKeys({
        title: 'referral-tree-test',
        type: 'publishable',
        created_by: 'referral-tree-test',
      });
      storeHeaders = { 'x-publishable-api-key': key.token };
      adminToken = await mintSuperAdmin(
        container,
        api,
        'referral-tree-admin@test.dev',
        PASSWORD,
      );
    });

    const adminHeaders = () => ({ authorization: `Bearer ${adminToken}` });

    const registerCustomer = async (email: string): Promise<string> => {
      const reg = await api.post('/auth/customer/emailpass/register', {
        email,
        password: PASSWORD,
      });
      const created = await postStoreCustomer(
        api,
        getContainer(),
        { email },
        {
          headers: {
            ...storeHeaders,
            authorization: `Bearer ${reg.data.token}`,
          },
        },
      );
      return created.data.customer.id;
    };

    /** grandparent -> root -> child -> grandchild, a 4-deep line. */
    async function seedLine(tag: string) {
      const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
      const grandparentId = await registerCustomer(`rt-${tag}-gp@test.dev`);
      const rootId = await registerCustomer(`rt-${tag}-root@test.dev`);
      const childId = await registerCustomer(`rt-${tag}-child@test.dev`);
      const grandchildId = await registerCustomer(`rt-${tag}-gc@test.dev`);
      await packs.createReferralRelationships([
        { customer_id: rootId, sponsor_id: grandparentId },
      ]);
      await packs.createReferralRelationships([
        { customer_id: childId, sponsor_id: rootId },
      ]);
      await packs.createReferralRelationships([
        { customer_id: grandchildId, sponsor_id: childId },
      ]);
      return { packs, grandparentId, rootId, childId, grandchildId };
    }

    const tree = async (id: string, maxDepth: number) =>
      unwrapResponse(
        api.get(`/admin/customers/${id}/referral-tree?maxDepth=${maxDepth}`, {
          headers: adminHeaders(),
        }),
      );

    const nodeFor = (res: any, id: string) =>
      res.data.nodes.find((n: any) => n.customer_id === id);

    it('walks DOWN only — the sponsor above the root is never a node', async () => {
      const { grandparentId, rootId, childId, grandchildId } =
        await seedLine('down');

      const res = await tree(rootId, 6);
      expect(res.status).toBe(200);
      const ids = res.data.nodes.map((n: any) => n.customer_id);
      expect(ids.sort()).toEqual([childId, grandchildId].sort());
      // The failure this exists for: an upward join would pull the sponsor in
      // and hand the admin someone else's upline.
      expect(ids).not.toContain(grandparentId);
      // The root still REPORTS its sponsor — it is a field on the root node,
      // not a walked edge.
      expect(res.data.root.sponsor_id).toBe(grandparentId);
      expect(res.data.root.depth).toBe(0);
    });

    it('counts direct recruits per node, not the whole subtree', async () => {
      const { rootId, childId, grandchildId } = await seedLine('counts');

      const res = await tree(rootId, 6);
      expect(res.data.root.direct_recruit_count).toBe(1); // child, NOT 2
      expect(nodeFor(res, childId).direct_recruit_count).toBe(1);
      expect(nodeFor(res, grandchildId).direct_recruit_count).toBe(0);
    });

    it('truncates at maxDepth and flags the clipped node with has_more_depth', async () => {
      const { rootId, childId, grandchildId } = await seedLine('depth');

      const shallow = await tree(rootId, 1);
      expect(shallow.data.maxDepth).toBe(1);
      expect(shallow.data.nodes.map((n: any) => n.customer_id)).toEqual([
        childId,
      ]);
      // The only signal the admin UI has that a subtree was cut off here.
      expect(nodeFor(shallow, childId).has_more_depth).toBe(true);

      const deep = await tree(rootId, 6);
      // Same node, uncut this time — the flag is about the CUT, not the node.
      expect(nodeFor(deep, childId).has_more_depth).toBe(false);
      expect(nodeFor(deep, grandchildId).has_more_depth).toBe(false);
    });

    it('prunes a soft-deleted relationship from the walk and from the counts', async () => {
      const { packs, rootId, childId, grandchildId } = await seedLine('soft');

      const [edge] = await packs.listReferralRelationships(
        { customer_id: grandchildId },
        { take: 1 },
      );
      await packs.softDeleteReferralRelationships([edge.id]);

      const res = await tree(rootId, 6);
      const ids = res.data.nodes.map((n: any) => n.customer_id);
      expect(ids).toEqual([childId]);
      expect(ids).not.toContain(grandchildId);
      // Every leg filters deleted_at IS NULL — the recursive walk AND the
      // per-node count, which is read by a different query.
      expect(nodeFor(res, childId).direct_recruit_count).toBe(0);
      expect(nodeFor(res, childId).has_more_depth).toBe(false);
    });
  },
});

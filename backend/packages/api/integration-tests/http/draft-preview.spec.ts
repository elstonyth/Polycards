import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import type { ICustomerModuleService } from '@medusajs/framework/types';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { clearPackDetailCache } from '../../src/api/store/packs/[slug]/route';
import { clearPackListCache } from '../../src/api/store/packs/route';
import { clearAdminPackListCache } from '../../src/api/admin/packs/route';
import { mintSuperAdmin, postStoreCustomer, unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

// A player group that can see Draft: staff test a pack before customers can see
// it. The rule that matters is the other half: nobody outside such a group can
// see or open a draft, and no cached public read ever carries one.

const PASSWORD = 'draft-preview-test-password-1'; // gitleaks:allow
const ADMIN_EMAIL = 'draft-preview-admin@test.dev';
const EMAIL = 'draft-preview-customer@test.dev';
const TICKET_PACK = 'gold-capsule';
const CARD_PACK = 'draft-card-pack';
const PRICE = 10;
const LIST = '/store/customers/me/draft-packs';

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('draft preview', () => {
      let storeHeaders: Record<string, string>;
      let adminToken: string;
      let customerToken: string;
      let customerId: string;
      let groupId: string;

      const packs = () =>
        getContainer().resolve<PacksModuleService>(PACKS_MODULE);
      const customers = () =>
        getContainer().resolve<ICustomerModuleService>(Modules.CUSTOMER);
      const admin = () => ({ authorization: `Bearer ${adminToken}` });
      const authed = () => ({
        ...storeHeaders,
        authorization: `Bearer ${customerToken}`,
      });

      const setAccess = (id: string, body: Record<string, unknown>) =>
        unwrapResponse(
          api.post(`/admin/customer-groups/${id}/draft-access`, body, {
            headers: admin(),
          }),
        );
      const allow = () =>
        setAccess(groupId, { sees_drafts: true, reason: 'boss test' });
      const moveCustomer = (target: string | null) =>
        unwrapResponse(
          api.post(
            `/admin/customers/${customerId}/group`,
            { group_id: target },
            { headers: admin() },
          ),
        );
      const createPack = (body: Record<string, unknown>) =>
        unwrapResponse(
          api.post(
            '/admin/packs',
            {
              category: 'poly',
              price: PRICE,
              image: '/cdn/capsule.webp',
              buyback_percent: 90,
              boost: false,
              rank: 0,
              status: 'draft',
              ...body,
            },
            { headers: admin() },
          ),
        );
      const draftTicketPack = async () => {
        const created = await createPack({
          slug: TICKET_PACK,
          title: 'Gold Capsule',
          prize_type: 'tickets',
        });
        expect(created.status).toBe(201);
        const rows = await unwrapResponse(
          api.post(
            `/admin/packs/${TICKET_PACK}/ticket-prizes`,
            {
              rows: [
                {
                  tickets: 100,
                  rarity: 'Rare',
                  locked: true,
                  pct: 100,
                  pct_2: null,
                  pct_3: null,
                },
              ],
            },
            { headers: admin() },
          ),
        );
        expect(rows.status).toBe(200);
      };
      const list = () =>
        unwrapResponse(api.get(LIST, { headers: authed() }));
      const detail = (slug = TICKET_PACK) =>
        unwrapResponse(api.get(`${LIST}/${slug}`, { headers: authed() }));
      const openBatch = (slug = TICKET_PACK) =>
        unwrapResponse(
          api.post(
            `/store/packs/${slug}/open-batch`,
            { count: 1 },
            { headers: authed() },
          ),
        );
      const deposit = (amount: number) =>
        packs().mutateCreditAtomic({
          customerId,
          amount,
          reason: 'topup',
          reference: `draft-preview-${amount}`,
        });
      const spins = () =>
        packs().listTicketSpins({ customer_id: customerId }, { take: 10 });

      beforeEach(async () => {
        clearPackDetailCache();
        clearPackListCache();
        clearAdminPackListCache();
        const container = getContainer();
        const key = await container.resolve(Modules.API_KEY).createApiKeys({
          title: 'draft-preview-test',
          type: 'publishable',
          created_by: 'draft-preview-test',
        });
        storeHeaders = { 'x-publishable-api-key': key.token };
        adminToken = await mintSuperAdmin(
          container,
          api,
          ADMIN_EMAIL,
          PASSWORD,
        );

        const reg = await api.post('/auth/customer/emailpass/register', {
          email: EMAIL,
          password: PASSWORD,
        });
        const created = await postStoreCustomer(
          api,
          container,
          { email: EMAIL },
          {
            headers: {
              ...storeHeaders,
              authorization: `Bearer ${reg.data.token}`,
            },
          },
        );
        customerId = created.data.customer.id;
        const login = await api.post('/auth/customer/emailpass', {
          email: EMAIL,
          password: PASSWORD,
        });
        customerToken = login.data.token;

        const group = await customers().createCustomerGroups({
          name: 'Staff testers',
          metadata: { odds_set: 1 },
        });
        groupId = group.id;
      });

      describe('reading', () => {
        it('needs a login', async () => {
          await draftTicketPack();
          const guest = await unwrapResponse(
            api.get(LIST, { headers: storeHeaders }),
          );
          expect(guest.status).toBe(401);
        });

        it('shows nothing to a customer outside such a group', async () => {
          await draftTicketPack();
          // In a real group, but one without the switch.
          expect((await moveCustomer(groupId)).status).toBe(200);

          const rows = await list();
          expect(rows.status).toBe(200);
          expect(rows.data.packs).toEqual([]);
          expect((await detail()).status).toBe(404);
        });

        it('shows drafts to a member, without the real rates', async () => {
          await draftTicketPack();
          expect((await moveCustomer(groupId)).status).toBe(200);
          expect((await allow()).status).toBe(200);

          const rows = await list();
          expect(rows.status).toBe(200);
          expect(rows.data.packs.map((p: { slug: string }) => p.slug)).toEqual([
            TICKET_PACK,
          ]);
          expect(rows.data.packs[0].status).toBe('draft');
          expect(rows.data.packs[0].prize_type).toBe('tickets');

          const one = await detail();
          expect(one.status).toBe(200);
          expect(one.data.pack.slug).toBe(TICKET_PACK);
          expect(one.data.prize_type).toBe('tickets');
          expect(one.data.odds[0].tickets).toBe(100);
          const wire = JSON.stringify(one.data);
          expect(wire).not.toContain('weight');
          expect(wire).not.toContain('locked');
        });

        it('leaves out reward boxes and the free pack', async () => {
          await draftTicketPack();
          expect((await moveCustomer(groupId)).status).toBe(200);
          expect((await allow()).status).toBe(200);
          await packs().createPacks([
            {
              slug: 'draft-reward-box',
              title: 'Box',
              category: 'reward_box',
              price: 0,
              image: '/cdn/box.webp',
              rank: 0,
              status: 'draft',
            },
            {
              slug: 'draft-free',
              title: 'Free',
              category: 'free_welcome',
              price: 0,
              image: '/cdn/free.webp',
              rank: 0,
              status: 'draft',
            },
          ] as never);

          const rows = await list();
          expect(rows.data.packs.map((p: { slug: string }) => p.slug)).toEqual([
            TICKET_PACK,
          ]);
          expect((await detail('draft-reward-box')).status).toBe(404);
          expect((await detail('draft-free')).status).toBe(404);
        });

        it('an active pack is not a draft', async () => {
          await draftTicketPack();
          expect((await moveCustomer(groupId)).status).toBe(200);
          expect((await allow()).status).toBe(200);
          const live = await unwrapResponse(
            api.post(
              `/admin/packs/${TICKET_PACK}`,
              {
                title: 'Gold Capsule',
                category: 'poly',
                price: PRICE,
                image: '/cdn/capsule.webp',
                buyback_percent: 90,
                boost: false,
                rank: 0,
                status: 'active',
              },
              { headers: admin() },
            ),
          );
          expect(live.status).toBe(200);

          expect((await list()).data.packs).toEqual([]);
          expect((await detail()).status).toBe(404);
        });

        it('never reaches the public, cached routes, even for a member', async () => {
          await draftTicketPack();
          expect((await moveCustomer(groupId)).status).toBe(200);
          expect((await allow()).status).toBe(200);
          expect((await list()).data.packs).toHaveLength(1);
          expect((await detail()).status).toBe(200);

          const catalog = await unwrapResponse(
            api.get('/store/packs', { headers: authed() }),
          );
          expect(catalog.status).toBe(200);
          expect(
            catalog.data.packs.some(
              (p: { slug: string }) => p.slug === TICKET_PACK,
            ),
          ).toBe(false);
          const one = await unwrapResponse(
            api.get(`/store/packs/${TICKET_PACK}`, { headers: authed() }),
          );
          expect(one.status).toBe(404);
        });

        it('stops the moment a member leaves the group', async () => {
          await draftTicketPack();
          expect((await moveCustomer(groupId)).status).toBe(200);
          expect((await allow()).status).toBe(200);
          expect((await list()).data.packs).toHaveLength(1);

          expect((await moveCustomer(null)).status).toBe(200);
          expect((await list()).data.packs).toEqual([]);
          expect((await detail()).status).toBe(404);
        });
      });

      describe('opening', () => {
        it('a member spins a draft ticket pack for real', async () => {
          await draftTicketPack();
          expect((await moveCustomer(groupId)).status).toBe(200);
          expect((await allow()).status).toBe(200);
          await deposit(100);

          const spin = await openBatch();
          expect(spin.status).toBe(200);
          expect(spin.data.prize_type).toBe('tickets');
          expect(spin.data.rolls[0].ticket_spin.tickets).toBe(100);
          expect(spin.data.ticket_balance).toBe(100);
          expect(await packs().creditBalance(customerId)).toBe(90);
          expect(await spins()).toHaveLength(1);
        });

        it('anyone else is refused before any charge', async () => {
          await draftTicketPack();
          expect((await moveCustomer(groupId)).status).toBe(200);
          await deposit(100);

          expect((await openBatch()).status).toBe(404);
          expect(await packs().creditBalance(customerId)).toBe(100);
          expect(await spins()).toHaveLength(0);
        });

        it('a member still cannot open a draft card pack', async () => {
          const created = await createPack({
            slug: CARD_PACK,
            title: 'Draft Cards',
          });
          expect(created.status).toBe(201);
          expect((await moveCustomer(groupId)).status).toBe(200);
          expect((await allow()).status).toBe(200);
          await deposit(100);

          // Listed, because a member can look at it...
          const rows = await list();
          expect(rows.data.packs.map((p: { slug: string }) => p.slug)).toEqual([
            CARD_PACK,
          ]);
          // ...but a card open writes pulls into the live feeds.
          expect((await openBatch(CARD_PACK)).status).toBe(404);
          expect(await packs().creditBalance(customerId)).toBe(100);
        });

        it('settleTicketSpins refuses a draft unless the caller allows it', async () => {
          await draftTicketPack();
          await deposit(100);
          await expect(
            packs().settleTicketSpins({
              customerId,
              packSlug: TICKET_PACK,
              unitPrice: PRICE,
              rolls: [{ tickets: 100 }],
              openId: 'draft-preview-open-1',
            }),
          ).rejects.toThrow();
          expect(await packs().creditBalance(customerId)).toBe(100);
        });
      });

      describe('the switch', () => {
        it('needs a reason and a boolean, and is audited', async () => {
          const noReason = await setAccess(groupId, { sees_drafts: true });
          expect(noReason.status).toBe(400);
          const notBoolean = await setAccess(groupId, {
            sees_drafts: 'yes',
            reason: 'x',
          });
          expect(notBoolean.status).toBe(400);

          const ok = await setAccess(groupId, {
            sees_drafts: true,
            reason: 'boss test',
          });
          expect(ok.status).toBe(200);
          expect(ok.data.customer_group.metadata.sees_drafts).toBe(true);

          const [audit] = await packs().listAdminActionAudits(
            { entity_type: 'customer_group', entity_id: groupId },
            { take: 5 },
          );
          expect(audit?.action).toBe('edit_group_policy');
          expect(audit?.reason).toBe('boss test');
          expect(audit?.before).toEqual({ sees_drafts: false });
          expect(audit?.after).toEqual({ sees_drafts: true });
        });

        it('turning it off stops access', async () => {
          await draftTicketPack();
          expect((await moveCustomer(groupId)).status).toBe(200);
          expect((await allow()).status).toBe(200);
          expect((await list()).data.packs).toHaveLength(1);

          const off = await setAccess(groupId, {
            sees_drafts: false,
            reason: 'done',
          });
          expect(off.status).toBe(200);
          expect((await list()).data.packs).toEqual([]);
        });

        it('refuses the default group, whose members are every customer', async () => {
          expect((await moveCustomer(null)).status).toBe(200);
          const [fallback] = await customers().listCustomerGroups({
            customers: customerId,
          });
          const refused = await setAccess(fallback.id, {
            sees_drafts: true,
            reason: 'oops',
          });
          expect(refused.status).toBe(400);
          // Even a row written some other way gives its members nothing.
          await customers().updateCustomerGroups(fallback.id, {
            metadata: { sees_drafts: true },
          });
          await draftTicketPack();
          expect((await list()).data.packs).toEqual([]);
        });

        it('the native metadata routes cannot set it, unaudited', async () => {
          const update = await unwrapResponse(
            api.post(
              `/admin/customer-groups/${groupId}`,
              { metadata: { sees_drafts: true } },
              { headers: admin() },
            ),
          );
          expect(update.status).toBe(400);
          const create = await unwrapResponse(
            api.post(
              '/admin/customer-groups',
              { name: 'Sneaky', metadata: { sees_drafts: true } },
              { headers: admin() },
            ),
          );
          expect(create.status).toBe(400);
        });

        it('survives the partner and odds-set writes on the same row', async () => {
          expect((await allow()).status).toBe(200);
          const policy = await unwrapResponse(
            api.post(
              `/admin/customer-groups/${groupId}/policy`,
              { partner_rate_bp: null, reason: 'not a partner' },
              { headers: admin() },
            ),
          );
          expect(policy.status).toBe(200);
          const odds = await unwrapResponse(
            api.post(
              `/admin/customer-groups/${groupId}/odds-set`,
              { odds_set: 2 },
              { headers: admin() },
            ),
          );
          expect(odds.status).toBe(200);
          const group = await customers().retrieveCustomerGroup(groupId);
          expect(group.metadata?.sees_drafts).toBe(true);
          expect(group.metadata?.odds_set).toBe(2);
        });
      });
    });
  },
});

// Test-only seed secret: publish and draw refuse without one.
process.env.LUCKY_DRAW_SEED_SECRET ??= 'test-lucky-draw-seed-secret';

import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { clearLuckyDrawCache } from '../../src/api/store/lucky-draw/view';
import { mintSuperAdmin, postStoreCustomer, unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

const PASSWORD = 'ldfw-test-password-1';
const HOUR = 60 * 60 * 1000;

// The forced winner (admin pick, guaranteed win 2026-11-24) through its admin
// route: who may be picked, what the pick writes, and that the draw job pays
// the pick whatever the seed says. The rules themselves are pinned in
// lucky-draw-operations.unit.spec.ts; this is the route and money end to end.
medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('Lucky Draw: forced winner', () => {
      let packs: PacksModuleService;
      let adminHeaders: Record<string, string>;
      let storeHeaders: Record<string, string>;
      let ada: { token: string; id: string };
      let bo: { token: string; id: string };

      const authed = (token: string): Record<string, string> => ({
        ...storeHeaders,
        authorization: `Bearer ${token}`,
      });
      const adminPost = (path: string, body: unknown) =>
        unwrapResponse(api.post(path, body, { headers: adminHeaders }));
      const force = (eventId: string, body: Record<string, unknown>) =>
        adminPost(`/admin/lucky-draw/events/${eventId}/forced-winner`, body);
      const enter = (
        eventId: string,
        tickets: number,
        headers: Record<string, string>,
      ) =>
        unwrapResponse(
          api.post(
            `/store/lucky-draw/events/${eventId}/enter`,
            { tickets },
            { headers },
          ),
        );

      const registerCustomer = async (email: string, firstName: string) => {
        const container = getContainer();
        const reg = await api.post('/auth/customer/emailpass/register', {
          email,
          password: PASSWORD,
        });
        await postStoreCustomer(
          api,
          container,
          { email },
          {
            headers: {
              ...storeHeaders,
              authorization: `Bearer ${reg.data.token}`,
            },
          },
        );
        const login = await api.post('/auth/customer/emailpass', {
          email,
          password: PASSWORD,
        });
        const token: string = login.data.token;
        const me = await unwrapResponse(
          api.get('/store/customers/me', { headers: authed(token) }),
        );
        expect(me.status).toBe(200);
        const id = me.data.customer.id as string;
        await container
          .resolve(Modules.CUSTOMER)
          .updateCustomers(id, { first_name: firstName });
        return { token, id };
      };

      // Top-up credit (the DEFAULT-group entry gate) plus spendable tickets.
      const fund = async (customerId: string, tickets: number) => {
        await packs.createCreditTransactions([
          { customer_id: customerId, amount: 50, reason: 'topup' },
        ]);
        await packs.createLuckyDrawTickets([
          {
            customer_id: customerId,
            delta: tickets,
            reason: 'task_claim',
            ref: `claim-${customerId}`,
          },
        ]);
      };

      const publishPot = async () => {
        const created = await adminPost('/admin/lucky-draw/events', {
          name: 'Forced Pot',
          starts_at: new Date(Date.now() - HOUR).toISOString(),
          ends_at: new Date(Date.now() + 48 * HOUR).toISOString(),
          reason: 'ldfw test',
          prizes: [{ kind: 'credit', credit_myr: 25, title: 'RM 25', sort: 0 }],
        });
        expect(created.status).toBe(200);
        const eventId = created.data.id as string;
        const published = await adminPost(
          `/admin/lucky-draw/events/${eventId}/publish`,
          { reason: 'go live' },
        );
        expect(published.status).toBe(200);
        const [event] = await packs.listLuckyDrawEvents({ id: eventId });
        return event;
      };

      const afterEnd = (event: { ends_at: Date | string }) =>
        new Date(new Date(event.ends_at).getTime() + 1000);

      beforeEach(async () => {
        clearLuckyDrawCache();
        const container = getContainer();
        packs = container.resolve<PacksModuleService>(PACKS_MODULE);
        const key = await container.resolve(Modules.API_KEY).createApiKeys({
          title: 'ldfw-store-test',
          type: 'publishable',
          created_by: 'ldfw-store-test',
        });
        storeHeaders = { 'x-publishable-api-key': key.token };
        adminHeaders = {
          authorization: `Bearer ${await mintSuperAdmin(
            container,
            api,
            'ldfw-admin@test.dev',
            PASSWORD,
          )}`,
        };
        ada = await registerCustomer('ldfw-ada@test.dev', 'Ada');
        bo = await registerCustomer('ldfw-bo@test.dev', 'Bo');
      });

      it('picks, shows and clears a live entrant, with an audit row', async () => {
        const event = await publishPot();
        await fund(ada.id, 100);
        await fund(bo.id, 100);
        expect((await enter(event.id, 30, authed(ada.token))).status).toBe(200);
        expect((await enter(event.id, 15, authed(bo.token))).status).toBe(200);

        const forced = await force(event.id, {
          customer_id: bo.id,
          reason: 'guarantee',
        });
        expect(forced.status).toBe(200);
        expect(forced.data).toEqual({ forced_winner_id: bo.id });

        // The pick is on the row, without re-publishing the gate.
        const [row] = await packs.listLuckyDrawEvents({ id: event.id });
        expect(row.forced_winner_id).toBe(bo.id);
        const [audit] = await packs.listAdminActionAudits({
          entity_type: 'lucky_draw_event',
          entity_id: event.id,
          action: 'edit',
        });
        expect(audit).toMatchObject({
          before: { forced_winner_id: null },
          after: { forced_winner_id: bo.id },
          reason: 'guarantee',
        });

        const cleared = await force(event.id, {
          customer_id: null,
          reason: 'undo',
        });
        expect(cleared.status).toBe(200);
        expect(cleared.data).toEqual({ forced_winner_id: null });
        expect(
          (await packs.listLuckyDrawEvents({ id: event.id }))[0]
            .forced_winner_id,
        ).toBeNull();
      });

      it('refuses anyone but a live entrant, and a pick without a reason', async () => {
        const event = await publishPot();
        await fund(ada.id, 100);
        expect((await enter(event.id, 5, authed(ada.token))).status).toBe(200);
        // bo is a real customer, but never entered this event.
        const refused = await force(event.id, {
          customer_id: bo.id,
          reason: 'nope',
        });
        expect(refused.status).toBe(400);
        expect(refused.data.message).toContain('live entrant');
        expect((await force(event.id, { customer_id: ada.id })).status).toBe(
          400,
        );
      });

      it('refuses an old per_prize event, and after the draw pays the pick whatever the seed says', async () => {
        // Only the module tier can still make a per_prize event: the admin
        // route and publish both force one_winner now.
        const [old] = await packs.createLuckyDrawEvents([
          {
            name: 'Old Draw',
            starts_at: new Date(Date.now() - HOUR),
            ends_at: new Date(Date.now() + 24 * HOUR),
            status: 'published' as const,
            created_by: 'user_ldfw',
          },
        ]);
        expect(old.draw_mode).toBe('per_prize');
        const oldRefused = await force(old.id, {
          customer_id: ada.id,
          reason: 'nope',
        });
        expect(oldRefused.status).toBe(400);
        expect(oldRefused.data.message).toContain('one-winner');

        const event = await publishPot();
        await fund(ada.id, 100);
        await fund(bo.id, 100);
        await enter(event.id, 30, authed(ada.token));
        await enter(event.id, 15, authed(bo.token));
        await force(event.id, { customer_id: bo.id, reason: 'guarantee' });

        expect(
          await packs.drawDueLuckyDrawEvents({ now: afterEnd(event) }),
        ).toEqual({ drawn: 1, failed: 0 });
        const [result] = await packs.listLuckyDrawEventResults({
          event_id: event.id,
        });
        expect(result).toMatchObject({
          winner_customer_id: bo.id,
          winner_tickets: 15,
          total_tickets: 45,
          entrant_count: 2,
        });
        // The pot went to the pick, seed notwithstanding.
        const credits = await packs.listCreditTransactions({
          reason: 'reward_credit',
        });
        expect(credits).toHaveLength(1);
        expect(credits[0].customer_id).toBe(bo.id);

        // Drawn: no second pick.
        const late = await force(event.id, {
          customer_id: ada.id,
          reason: 'late',
        });
        expect(late.status).toBe(400);
        expect(late.data.message).toContain('already been drawn');
      });
    });
  },
});

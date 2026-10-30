// Test-only seed secret: publish and draw refuse without one.
process.env.LUCKY_DRAW_SEED_SECRET ??= 'test-lucky-draw-seed-secret';

import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import {
  LUCKY_DRAW_PULL_PACK_ID,
  deriveDrawSeed,
  drawSeedHash,
  drawWinner,
} from '../../src/modules/packs/lucky-draw';
import { clearFxDisplayCache } from '../../src/modules/packs/pricing';
import { clearLuckyDrawCache } from '../../src/api/store/lucky-draw/view';
import { mintSuperAdmin, postStoreCustomer, unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

const PASSWORD = 'ldow-test-password-1';
const HOUR = 60 * 60 * 1000;
const CARD_HANDLE = 'ldow-card';

// The one-winner event end to end through its routes, on a database the real
// migrations built: the hand-written CHECK on an entry's target and the unique
// index on the event result are live here, unlike in the module tier. The rules
// themselves are pinned in lucky-draw-one-winner.integration.spec.ts.
medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('Lucky Draw: one winner per event', () => {
      let packs: PacksModuleService;
      let adminHeaders: Record<string, string>;
      let storeHeaders: Record<string, string>;
      let ada: { token: string; id: string };
      let bo: { token: string; id: string };

      const authed = (token: string): Record<string, string> => ({
        ...storeHeaders,
        authorization: `Bearer ${token}`,
      });
      const get = (path: string, headers: Record<string, string>) =>
        unwrapResponse(api.get(path, { headers }));
      const adminPost = (path: string, body: unknown) =>
        unwrapResponse(api.post(path, body, { headers: adminHeaders }));
      const enter = (
        eventId: string,
        body: unknown,
        headers: Record<string, string>,
      ) =>
        unwrapResponse(
          api.post(`/store/lucky-draw/events/${eventId}/enter`, body, {
            headers,
          }),
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
        const me = await get('/store/customers/me', authed(token));
        expect(me.status).toBe(200);
        const id = me.data.customer.id as string;
        await container
          .resolve(Modules.CUSTOMER)
          .updateCustomers(id, { first_name: firstName });
        return { token, id };
      };

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

      // Through the routes: a pot of two credit prizes and a card, published.
      const publishPot = async (over: Record<string, unknown> = {}) => {
        const created = await adminPost('/admin/lucky-draw/events', {
          name: 'November Pot',
          starts_at: new Date(Date.now() - HOUR).toISOString(),
          ends_at: new Date(Date.now() + 48 * HOUR).toISOString(),
          reason: 'ldow test',
          prizes: [
            {
              kind: 'card',
              card_handle: CARD_HANDLE,
              title: 'The card',
              sort: 0,
            },
            { kind: 'credit', credit_myr: 25, title: 'RM 25', sort: 1 },
            { kind: 'credit', credit_myr: 10.5, title: 'RM 10.50', sort: 2 },
          ],
          ...over,
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

      const allKeys = (value: unknown): string[] =>
        Array.isArray(value)
          ? value.flatMap(allKeys)
          : value && typeof value === 'object'
            ? Object.entries(value).flatMap(([k, v]) => [k, ...allKeys(v)])
            : [];

      beforeEach(async () => {
        clearLuckyDrawCache();
        clearFxDisplayCache();
        const container = getContainer();
        packs = container.resolve<PacksModuleService>(PACKS_MODULE);
        const key = await container.resolve(Modules.API_KEY).createApiKeys({
          title: 'ldow-store-test',
          type: 'publishable',
          created_by: 'ldow-store-test',
        });
        storeHeaders = { 'x-publishable-api-key': key.token };
        adminHeaders = {
          authorization: `Bearer ${await mintSuperAdmin(
            container,
            api,
            'ldow-admin@test.dev',
            PASSWORD,
          )}`,
        };
        await packs.createFxRates([
          { pair: 'USD_MYR', rate: 4, source: 'test' },
        ]);
        await packs.createCards([
          {
            handle: CARD_HANDLE,
            name: 'One Winner Test Card',
            set: 'Test Set',
            grader: 'PSA',
            grade: '10',
            market_value: 50,
            market_multiplier: 1.2,
            image: '/cdn/ldow-card.webp',
          },
        ]);
        ada = await registerCustomer('ldow-ada@test.dev', 'Ada');
        bo = await registerCustomer('ldow-bo@test.dev', 'Bo');
      });

      it('enter, draw, pay everything once, and show the result on every route', async () => {
        const event = await publishPot();
        expect(event.draw_mode).toBe('one_winner');
        await fund(ada.id, 100);
        await fund(bo.id, 100);

        // Open: the pot on the page, no seed anywhere, the viewer's own tickets.
        const entered = await enter(
          event.id,
          { tickets: 30 },
          authed(ada.token),
        );
        expect(entered.status).toBe(200);
        expect(entered.data).toMatchObject({
          entered: true,
          balance: 70,
          myTickets: 30,
        });
        const again = await enter(event.id, { tickets: 5 }, authed(ada.token));
        expect(again.data).toMatchObject({ balance: 65, myTickets: 35 });
        await enter(event.id, { tickets: 15 }, authed(bo.token));

        const seed = deriveDrawSeed(
          process.env.LUCKY_DRAW_SEED_SECRET!,
          event.seed_nonce!,
        );
        clearLuckyDrawCache();
        const open = await get('/store/lucky-draw', authed(ada.token));
        expect(open.status).toBe(200);
        expect(open.data.event).toMatchObject({
          id: event.id,
          name: 'November Pot',
          draw_mode: 'one_winner',
          seed_hash: event.seed_hash,
          total_tickets: 50,
          entrant_count: 2,
          my_tickets: 35,
          result: null,
        });
        expect(open.data.event.top).toEqual([
          { person: expect.objectContaining({ who: 'Ada' }), tickets: 35 },
          { person: expect.objectContaining({ who: 'Bo' }), tickets: 15 },
        ]);
        expect(open.data.next_event).toBeNull();
        expect(open.data.prizes.map((p: { title: string }) => p.title)).toEqual(
          ['The card', 'RM 25', 'RM 10.50'],
        );
        expect(JSON.stringify(open.data)).not.toContain(seed);
        expect(allKeys(open.data)).not.toContain('seed_nonce');
        expect(allKeys(open.data)).not.toContain('customer_id');
        for (const p of open.data.prizes) {
          expect(p.draw_at).toBe(new Date(event.ends_at).toISOString());
        }

        // my_tickets is per viewer, outside the 10 s shared cache.
        const boView = await get('/store/lucky-draw', authed(bo.token));
        expect(boView.data.event.my_tickets).toBe(15);
        await enter(event.id, { tickets: 1 }, authed(bo.token));
        const boLater = await get('/store/lucky-draw', authed(bo.token));
        expect(boLater.data.event.my_tickets).toBe(16);
        // ...while the shared total waits for the cache.
        expect(boLater.data.event.total_tickets).toBe(50);

        // A page and a poll before the draw: a 404, and it is remembered briefly.
        const before = await get(
          `/store/lucky-draw/results/events/${event.id}`,
          authed(ada.token),
        );
        expect(before.status).toBe(404);
        clearLuckyDrawCache();

        // The draw.
        const stock = jest.fn().mockResolvedValue(true);
        expect(
          await packs.drawDueLuckyDrawEvents({
            now: afterEnd(event),
            decrementStock: stock,
          }),
        ).toEqual({ drawn: 1, failed: 0 });
        expect(
          await packs.drawDueLuckyDrawEvents({ now: afterEnd(event) }),
        ).toEqual({ drawn: 0, failed: 0 });

        const entries = [
          { customer_id: ada.id, tickets: 35 },
          { customer_id: bo.id, tickets: 16 },
        ].sort((a, b) => (a.customer_id < b.customer_id ? -1 : 1));
        const pick = drawWinner(entries, seed, event.id)!;
        const winner = pick.winner.customer_id;
        const loser = winner === ada.id ? bo.id : ada.id;
        const winnerName = winner === ada.id ? 'Ada' : 'Bo';

        // The winner holds all three prizes, the loser none.
        const credits = await packs.listCreditTransactions({
          reason: 'reward_credit',
        });
        expect(credits.map((c) => Number(c.amount)).sort()).toEqual([10.5, 25]);
        expect(new Set(credits.map((c) => c.customer_id))).toEqual(
          new Set([winner]),
        );
        const pulls = await packs.listPulls({
          pack_id: LUCKY_DRAW_PULL_PACK_ID,
        });
        expect(pulls.map((p) => [p.customer_id, p.card_id])).toEqual([
          [winner, CARD_HANDLE],
        ]);
        expect(stock).toHaveBeenCalledTimes(1);
        expect(await packs.luckyDrawBalance(loser)).toBe(
          loser === ada.id ? 65 : 84,
        );

        // The detail route: the storefront's parse needs these exact fields.
        const detail = await get(
          `/store/lucky-draw/results/events/${event.id}`,
          authed(bo.token),
        );
        expect(detail.status).toBe(200);
        expect(detail.data.result).toEqual({
          winner: expect.objectContaining({ who: winnerName }),
          winner_tickets: pick.winner.tickets,
          total_tickets: 51,
          entrant_count: 2,
          seed,
          seed_hash: event.seed_hash,
          drawn_at: expect.any(String),
        });
        expect(drawSeedHash(detail.data.result.seed)).toBe(
          detail.data.result.seed_hash,
        );
        expect(detail.data.ticket_index).toBe(pick.ticketIndex);
        expect(detail.data.prizes).toEqual([
          {
            kind: 'card',
            title: 'The card',
            image: '/cdn/ldow-card.webp',
            value_myr: 240,
          },
          { kind: 'credit', title: 'RM 25', image: null, value_myr: 25 },
          { kind: 'credit', title: 'RM 10.50', image: null, value_myr: 10.5 },
        ]);
        expect(
          detail.data.entries.map((e: { tickets: number }) => e.tickets),
        ).toEqual(entries.map((e) => e.tickets));
        expect(allKeys(detail.data.entries)).not.toContain('customer_id');

        // The page after the draw: the same result, nothing left to enter.
        clearLuckyDrawCache();
        const drawn = await get('/store/lucky-draw', authed(ada.token));
        expect(drawn.data.event.result).toMatchObject({
          winner: expect.objectContaining({ who: winnerName }),
          seed,
          total_tickets: 51,
        });
        expect(drawn.data.event.total_tickets).toBe(51);
        const refused = await enter(
          event.id,
          { tickets: 1 },
          authed(ada.token),
        );
        expect(refused.data).toEqual({ entered: false, reason: 'closed' });

        // The feed: one row for the event, no mirror rows, the old schema's fields.
        const feed = await get('/store/lucky-draw/results', authed(ada.token));
        expect(feed.status).toBe(200);
        expect(feed.data.results).toHaveLength(1);
        const prizes = await packs.listLuckyDrawPrizes(
          { event_id: event.id },
          { order: { sort: 'ASC', id: 'ASC' } },
        );
        expect(feed.data.results[0]).toEqual({
          prize_id: prizes[0].id,
          title: 'November Pot',
          image: '/cdn/ldow-card.webp',
          value_myr: 275.5,
          drawn_at: expect.any(String),
          winner: expect.objectContaining({ who: winnerName }),
          winner_tickets: pick.winner.tickets,
          total_tickets: 51,
          entrant_count: 2,
          seed,
          seed_hash: event.seed_hash,
          event_id: event.id,
          draw_mode: 'one_winner',
          event_name: 'November Pot',
          prize_count: 3,
        });
        expect(feed.data.next_before).toBeNull();

        // My tickets: one row per event, an outcome for each viewer.
        const adaMe = await get('/store/lucky-draw/me', authed(ada.token));
        expect(adaMe.status).toBe(200);
        expect(adaMe.data.entries).toEqual([
          {
            prize_id: event.id,
            event_id: event.id,
            title: 'November Pot',
            image: '/cdn/ldow-card.webp',
            my_tickets: 35,
            draw_at: new Date(event.ends_at).toISOString(),
            status: winner === ada.id ? 'won' : 'lost',
          },
        ]);

        // The admin screen reads the outcome from the prize rows, all granted.
        const overview = await unwrapResponse(
          api.get('/admin/lucky-draw', { headers: adminHeaders }),
        );
        const row = overview.data.events.find(
          (e: { id: string }) => e.id === event.id,
        );
        expect(row).toMatchObject({
          draw_mode: 'one_winner',
          seed_hash: event.seed_hash,
          total_tickets: 51,
          entrant_count: 2,
        });
        expect(row.prizes).toHaveLength(3);
        for (const p of row.prizes) {
          expect(p.result).toMatchObject({
            winner_customer_id: winner,
            seed,
            granted: true,
          });
        }

        // Withdraw is over once it has a result.
        const late = await adminPost(
          `/admin/lucky-draw/events/${event.id}/withdraw`,
          { reason: 'too late' },
        );
        expect(late.status).toBe(400);
      });

      it('answers an overlapping publish with a 409 naming the clash', async () => {
        await publishPot({ name: 'Live Pot' });
        const clash = await adminPost('/admin/lucky-draw/events', {
          name: 'Clashing Pot',
          starts_at: new Date(Date.now() - HOUR).toISOString(),
          ends_at: new Date(Date.now() + HOUR).toISOString(),
          reason: 'ldow test',
          prizes: [{ kind: 'credit', credit_myr: 5, title: 'RM 5', sort: 0 }],
        });
        const res = await adminPost(
          `/admin/lucky-draw/events/${clash.data.id}/publish`,
          { reason: 'go live' },
        );
        expect(res.status).toBe(409);
        expect(res.data).toEqual({
          type: 'conflict',
          message: expect.stringContaining('Live Pot'),
        });
      });

      it('answers a prize added to a finished old event with the same 409', async () => {
        const [old] = await packs.createLuckyDrawEvents([
          {
            name: 'Finished Old',
            starts_at: new Date(Date.now() - HOUR),
            ends_at: new Date(Date.now() + 48 * HOUR),
            status: 'published',
            created_by: 'user_t',
          },
        ]);
        await publishPot({ name: 'New Pot' });
        const res = await adminPost('/admin/lucky-draw/prizes', {
          event_id: old.id,
          kind: 'credit',
          credit_myr: 5,
          title: 'Woken up',
          sort: 0,
          reason: 'ldow test',
        });
        expect(res.status).toBe(409);
        expect(res.data.message).toContain('New Pot');
      });

      it('lists entrants, withdraws with refunds, and the view follows', async () => {
        const event = await publishPot();
        await fund(ada.id, 100);
        await fund(bo.id, 100);
        await enter(event.id, { tickets: 30 }, authed(ada.token));
        await enter(event.id, { tickets: 40 }, authed(bo.token));
        await enter(event.id, { tickets: 5 }, authed(ada.token));

        const entrants = await unwrapResponse(
          api.get(`/admin/lucky-draw/events/${event.id}/entrants`, {
            headers: adminHeaders,
          }),
        );
        expect(entrants.status).toBe(200);
        expect(entrants.data).toEqual({
          entries: [
            { customer_id: bo.id, tickets: 40 },
            { customer_id: ada.id, tickets: 35 },
          ],
        });
        const missing = await unwrapResponse(
          api.get('/admin/lucky-draw/events/ldev_missing/entrants', {
            headers: adminHeaders,
          }),
        );
        expect(missing.status).toBe(404);

        // Needs a reason, as every admin write does.
        expect(
          (await adminPost(`/admin/lucky-draw/events/${event.id}/withdraw`, {}))
            .status,
        ).toBe(400);
        const withdrawn = await adminPost(
          `/admin/lucky-draw/events/${event.id}/withdraw`,
          { reason: 'pulled it' },
        );
        expect(withdrawn.status).toBe(200);
        expect(withdrawn.data).toEqual({ refunded: 2 });
        expect(await packs.luckyDrawBalance(ada.id)).toBe(100);
        expect(await packs.luckyDrawBalance(bo.id)).toBe(100);

        const adaMe = await get('/store/lucky-draw/me', authed(ada.token));
        expect(adaMe.data.entries).toEqual([
          expect.objectContaining({
            event_id: event.id,
            image: '/cdn/ldow-card.webp',
            my_tickets: 35,
            status: 'cancelled',
          }),
        ]);
        clearLuckyDrawCache();
        const page = await get('/store/lucky-draw', authed(ada.token));
        expect(page.data.event).toBeNull();

        expect(
          await packs.drawDueLuckyDrawEvents({ now: afterEnd(event) }),
        ).toEqual({ drawn: 0, failed: 0 });
      });

      it('no entries: the seed still shows, nothing is paid', async () => {
        const event = await publishPot();
        await packs.drawDueLuckyDrawEvents({ now: afterEnd(event) });
        const detail = await get(
          `/store/lucky-draw/results/events/${event.id}`,
          authed(ada.token),
        );
        expect(detail.status).toBe(200);
        expect(detail.data).toMatchObject({
          result: {
            winner: null,
            winner_tickets: 0,
            total_tickets: 0,
            entrant_count: 0,
            seed: deriveDrawSeed(
              process.env.LUCKY_DRAW_SEED_SECRET!,
              event.seed_nonce!,
            ),
          },
          entries: [],
          ticket_index: null,
        });
        expect(
          await packs.listCreditTransactions({ reason: 'reward_credit' }),
        ).toHaveLength(0);
        expect(
          await packs.listPulls({ pack_id: LUCKY_DRAW_PULL_PACK_ID }),
        ).toHaveLength(0);
      });

      it('refuses over the route with a 200, and a bad amount with a 400', async () => {
        const event = await publishPot();
        const refused = await enter(
          event.id,
          { tickets: 1 },
          authed(ada.token),
        );
        expect(refused.status).toBe(200);
        expect(refused.data).toEqual({ entered: false, reason: 'no_topup' });
        const missing = await enter(
          'ldev_missing',
          { tickets: 1 },
          authed(ada.token),
        );
        expect(missing.data).toEqual({ entered: false, reason: 'not_found' });
        expect(
          (await enter(event.id, { tickets: 0 }, authed(ada.token))).status,
        ).toBe(400);
      });

      it('blocks deleting a card in a published, undrawn event', async () => {
        const event = await publishPot();
        const held = await unwrapResponse(
          api.delete(`/admin/cards/${CARD_HANDLE}`, { headers: adminHeaders }),
        );
        expect(held.status).toBe(400);
        expect(JSON.stringify(held.data)).toContain('November Pot');
        expect(await packs.listCards({ handle: CARD_HANDLE })).toHaveLength(1);

        await packs.drawDueLuckyDrawEvents({ now: afterEnd(event) });
        expect(await packs.luckyDrawEventHoldingCard(CARD_HANDLE)).toBeNull();
      });

      it('needs a login on every new route', async () => {
        const event = await publishPot();
        for (const path of [`/store/lucky-draw/results/events/${event.id}`]) {
          expect((await get(path, storeHeaders)).status).toBe(401);
        }
        expect(
          (await enter(event.id, { tickets: 1 }, storeHeaders)).status,
        ).toBe(401);
        expect(
          (
            await unwrapResponse(
              api.get(`/admin/lucky-draw/events/${event.id}/entrants`),
            )
          ).status,
        ).toBe(401);
        expect(
          (
            await unwrapResponse(
              api.post(`/admin/lucky-draw/events/${event.id}/withdraw`, {
                reason: 'x',
              }),
            )
          ).status,
        ).toBe(401);
      });
    });
  },
});

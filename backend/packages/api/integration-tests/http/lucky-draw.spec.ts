// Test-only seed secret: publish and draw refuse without one (later tasks).
process.env.LUCKY_DRAW_SEED_SECRET ??= 'test-lucky-draw-seed-secret';

import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import {
  commitDrawSeed,
  deriveDrawSeed,
  drawSeedHash,
} from '../../src/modules/packs/lucky-draw';
import { clearFxDisplayCache } from '../../src/modules/packs/pricing';
import { clearLuckyDrawCache } from '../../src/api/store/lucky-draw/view';
import { mintSuperAdmin, postStoreCustomer, unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

const PASSWORD = 'ld-test-password-1';
const HOUR = 60 * 60 * 1000;
const CARD_HANDLE = 'ld-card';

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('Lucky Draw', () => {
      it('migrations create the lucky draw tables and task tickets column', async () => {
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        const [ev] = await packs.createLuckyDrawEvents([
          {
            name: 'Nov',
            starts_at: new Date(),
            ends_at: new Date(Date.now() + 86400e3),
            created_by: 'user_t',
          },
        ]);
        expect(ev.status).toBe('draft');
        const [t] = await packs.createTaskDefinitions([
          {
            kind: 'daily',
            title: 'x',
            requirement: { type: 'checkin_days', days: 1 },
            reward: { type: 'credit', amount_myr: 1 },
          },
        ]);
        expect(t.tickets).toBe(0);
      });

      describe('admin API', () => {
        let packs: PacksModuleService;
        let adminHeaders: Record<string, string>;

        beforeEach(async () => {
          // Module state outlives the per-test database reset.
          clearFxDisplayCache();
          const container = getContainer();
          packs = container.resolve<PacksModuleService>(PACKS_MODULE);
          const token = await mintSuperAdmin(
            container,
            api,
            'ld-admin@test.dev',
            PASSWORD,
          );
          adminHeaders = { authorization: `Bearer ${token}` };
          // Card value: FMV $50 x FX 4 x markup 1.2 = RM 240.
          await packs.createFxRates([
            { pair: 'USD_MYR', rate: 4, source: 'test' },
          ]);
          await packs.createCards([
            {
              handle: CARD_HANDLE,
              name: 'Lucky Draw Test Card',
              set: 'Test Set',
              grader: 'PSA',
              grade: '10',
              market_value: 50,
              market_multiplier: 1.2,
              image: '/cdn/ld-card.webp',
            },
          ]);
        });

        const post = (path: string, body: unknown) =>
          unwrapResponse(api.post(path, body, { headers: adminHeaders }));
        const get = (path: string, headers = adminHeaders) =>
          unwrapResponse(api.get(path, { headers }));

        const eventBody = (over: Record<string, unknown> = {}) => ({
          name: 'November Lucky Draw',
          starts_at: new Date(Date.now() - HOUR).toISOString(),
          ends_at: new Date(Date.now() + 48 * HOUR).toISOString(),
          reason: 'ld api test',
          ...over,
        });
        const creditPrizeBody = (
          eventId: string,
          over: Record<string, unknown> = {},
        ) => ({
          event_id: eventId,
          kind: 'credit',
          credit_myr: 25,
          title: 'RM 25 credit',
          image_url: '/cdn/ld-credit.webp',
          sort: 2,
          reason: 'ld api test',
          ...over,
        });
        const cardPrizeBody = (
          eventId: string,
          over: Record<string, unknown> = {},
        ) => ({
          event_id: eventId,
          kind: 'card',
          card_handle: CARD_HANDLE,
          title: 'Test card',
          sort: 1,
          reason: 'ld api test',
          ...over,
        });

        // An old-rule event with one card prize and one credit prize. A publish
        // now makes a one_winner event, so the event is seeded; its prizes go
        // through the route, which commits them at creation.
        const publishedEvent = async () => {
          const [ev] = await packs.createLuckyDrawEvents([
            {
              name: 'November Lucky Draw',
              starts_at: new Date(Date.now() - HOUR),
              ends_at: new Date(Date.now() + 48 * HOUR),
              status: 'published',
              created_by: 'user_t',
            },
          ]);
          const eventId = ev.id;
          const card = await post(
            '/admin/lucky-draw/prizes',
            cardPrizeBody(eventId),
          );
          const credit = await post(
            '/admin/lucky-draw/prizes',
            creditPrizeBody(eventId),
          );
          expect([card.status, credit.status]).toEqual([200, 200]);
          return {
            eventId,
            cardId: card.data.id as string,
            creditId: credit.data.id as string,
          };
        };

        it('GET /admin/lucky-draw never returns an undrawn prize seed', async () => {
          const { eventId, cardId, creditId } = await publishedEvent();
          const [row] = await packs.listLuckyDrawPrizes({ id: cardId });
          expect(row).not.toHaveProperty('seed'); // the prize row holds only the nonce
          const seed = deriveDrawSeed(
            process.env.LUCKY_DRAW_SEED_SECRET!,
            row.seed_nonce!,
          );
          expect(drawSeedHash(seed)).toBe(row.seed_hash);

          const res = await get('/admin/lucky-draw');
          expect(res.status).toBe(200);
          // Check the secret itself — `seed` is also a field name elsewhere.
          expect(JSON.stringify(res.data)).not.toContain(seed);

          const ev = res.data.events[0];
          expect(ev).toMatchObject({
            id: eventId,
            name: 'November Lucky Draw',
            status: 'published',
          });
          // Dates as ISO strings, numbers as numbers; ordered by sort.
          expect(typeof ev.starts_at).toBe('string');
          expect(ev.prizes.map((p: { id: string }) => p.id)).toEqual([
            cardId,
            creditId,
          ]);
          expect(ev.prizes[0]).toMatchObject({
            kind: 'card',
            card_handle: CARD_HANDLE,
            credit_myr: null,
            seed_hash: row.seed_hash,
            value_myr: 240,
            total_tickets: 0,
            entrant_count: 0,
            result: null,
          });
          expect(typeof ev.prizes[0].draw_at).toBe('string');
          expect(ev.prizes[1]).toMatchObject({
            kind: 'credit',
            credit_myr: 25,
            value_myr: 25,
          });
          for (const p of ev.prizes) {
            expect(p).not.toHaveProperty('seed');
            expect(p).not.toHaveProperty('seed_nonce');
          }
        });

        it('audits each admin write (the CHECK lists accept the new entity types)', async () => {
          const ev = await post(
            '/admin/lucky-draw/events',
            eventBody({
              starts_at: new Date(Date.now() + HOUR).toISOString(),
            }),
          );
          const eventId = ev.data.id as string;
          const card = await post(
            '/admin/lucky-draw/prizes',
            cardPrizeBody(eventId),
          );
          const cardId = card.data.id as string;
          await post('/admin/lucky-draw/prizes', creditPrizeBody(eventId));
          const published = await post(
            `/admin/lucky-draw/events/${eventId}/publish`,
            { reason: 'go live' },
          );
          expect(published.status).toBe(200);
          const cancelled = await post(
            `/admin/lucky-draw/prizes/${cardId}/cancel`,
            { reason: 'pulled' },
          );
          expect(cancelled.status).toBe(200);

          const eventAudits = await packs.listAdminActionAudits({
            entity_type: 'lucky_draw_event',
            entity_id: eventId,
          });
          expect(eventAudits.map((a) => a.action).sort()).toEqual([
            'create',
            'publish',
          ]);
          const prizeAudits = await packs.listAdminActionAudits({
            entity_type: 'lucky_draw_prize',
            entity_id: cardId,
          });
          expect(prizeAudits.map((a) => a.action).sort()).toEqual([
            'create',
            'disable',
          ]);
        });

        it('POST /admin/lucky-draw/events with prizes creates the event and its pool in one request', async () => {
          const created = await post(
            '/admin/lucky-draw/events',
            eventBody({
              prizes: [
                {
                  kind: 'card',
                  card_handle: CARD_HANDLE,
                  title: 'Test card',
                  sort: 0,
                },
                {
                  kind: 'credit',
                  credit_myr: 25,
                  title: 'RM 25 bonus credit',
                  image_url: '/cdn/ld-credit.webp',
                  sort: 1,
                },
              ],
            }),
          );
          expect(created.status).toBe(200);
          const { id, prize_ids: prizeIds } = created.data as {
            id: string;
            prize_ids: string[];
          };
          expect(prizeIds).toHaveLength(2);

          const overview = await get('/admin/lucky-draw');
          const ev = overview.data.events.find(
            (e: { id: string }) => e.id === id,
          );
          expect(ev).toMatchObject({ status: 'draft' });
          expect(ev.prizes.map((p: { id: string }) => p.id)).toEqual(prizeIds);
          expect(ev.prizes[0]).toMatchObject({
            kind: 'card',
            card_handle: CARD_HANDLE,
            value_myr: 240,
            seed_hash: null,
          });
          expect(ev.prizes[1]).toMatchObject({
            kind: 'credit',
            credit_myr: 25,
            image_url: '/cdn/ld-credit.webp',
          });
          // Each prize draws at the event's end.
          for (const p of ev.prizes) expect(p.draw_at).toBe(ev.ends_at);

          // A pool made this way publishes like any other draft.
          const published = await post(
            `/admin/lucky-draw/events/${id}/publish`,
            { reason: 'go live' },
          );
          expect(published.status).toBe(200);
        });

        it('POST /admin/lucky-draw/events without prizes still creates a plain draft, and an edit returns no prize ids', async () => {
          const created = await post('/admin/lucky-draw/events', eventBody());
          expect(created.status).toBe(200);
          expect(created.data.prize_ids).toEqual([]);
          const edited = await post(
            '/admin/lucky-draw/events',
            eventBody({ id: created.data.id, name: 'Renamed' }),
          );
          expect(edited.status).toBe(200);
          expect(edited.data).toEqual({ id: created.data.id, prize_ids: [] });
        });

        it('POST /admin/lucky-draw/events refuses prizes on an edit and a bad pool without writing', async () => {
          const existing = await post('/admin/lucky-draw/events', eventBody());
          const withId = await post(
            '/admin/lucky-draw/events',
            eventBody({
              id: existing.data.id,
              prizes: [
                {
                  kind: 'card',
                  card_handle: CARD_HANDLE,
                  title: 'Test card',
                },
              ],
            }),
          );
          expect(withId.status).toBe(400);
          expect(
            await packs.listLuckyDrawPrizes({ event_id: existing.data.id }),
          ).toHaveLength(0);

          const events = (await packs.listLuckyDrawEvents({})).length;
          for (const prizes of [
            [{ kind: 'credit', credit_myr: 0, title: 'Nothing' }],
            [{ kind: 'card', card_handle: 'no-such-card', title: 'Ghost' }],
            [{ kind: 'cash', title: 'Cash' }],
            Array.from({ length: 101 }, () => ({
              kind: 'card',
              card_handle: CARD_HANDLE,
              title: 'Test card',
            })),
          ]) {
            const res = await post(
              '/admin/lucky-draw/events',
              eventBody({ name: 'Bad pool', prizes }),
            );
            expect(res.status).toBe(400);
          }
          expect(await packs.listLuckyDrawEvents({})).toHaveLength(events);
          expect(await packs.listLuckyDrawPrizes({})).toHaveLength(0);
        });

        it('POST /admin/customers/:id/lucky-draw-tickets gives and takes back tickets', async () => {
          const [customer] = await getContainer()
            .resolve(Modules.CUSTOMER)
            .createCustomers([{ email: 'ld-gift@test.dev' }]);
          const url = `/admin/customers/${customer.id}/lucky-draw-tickets`;

          const given = await post(url, {
            tickets: 40,
            note: 'Launch gift',
            idempotency_key: 'h1',
          });
          expect(given.status).toBe(200);
          expect(given.data).toEqual({ tickets: 40, balance: 40 });
          // A retry with the same key replays rather than granting twice.
          const replay = await post(url, {
            tickets: 40,
            note: 'Launch gift',
            idempotency_key: 'h1',
          });
          expect(replay.status).toBe(200);
          expect(replay.data).toEqual({ tickets: 40, balance: 40 });
          const clash = await post(url, {
            tickets: 41,
            note: 'Launch gift',
            idempotency_key: 'h1',
          });
          expect(clash.status).toBe(409);
          expect(clash.data.message).toMatch(/different amount/);

          const back = await post(url, { tickets: -15, note: 'Mistake' });
          expect(back.data).toEqual({ tickets: -15, balance: 25 });
          expect(
            (await post(url, { tickets: -26, note: 'Too much' })).status,
          ).toBe(400);
          expect((await post(url, { tickets: 0, note: 'x' })).status).toBe(400);
          expect((await post(url, { tickets: 5 })).status).toBe(400);
          expect(
            (
              await post('/admin/customers/cus_missing/lucky-draw-tickets', {
                tickets: 5,
                note: 'x',
              })
            ).status,
          ).toBe(404);

          const history = await get(
            `/admin/lucky-draw/tickets?customer_id=${customer.id}`,
          );
          expect(history.data.balance).toBe(25);
          expect(
            history.data.rows.map((r: { reason: string }) => r.reason),
          ).toEqual(['admin_grant', 'admin_grant']);
        });

        it('refuses bad bodies without writing', async () => {
          const noReason = await post('/admin/lucky-draw/events', {
            ...eventBody(),
            reason: undefined,
          });
          expect(noReason.status).toBe(400);
          const badDate = await post(
            '/admin/lucky-draw/events',
            eventBody({ starts_at: 'soon' }),
          );
          expect(badDate.status).toBe(400);
          const backwards = await post(
            '/admin/lucky-draw/events',
            eventBody({
              starts_at: new Date(Date.now() + HOUR).toISOString(),
              ends_at: new Date(Date.now()).toISOString(),
            }),
          );
          expect(backwards.status).toBe(400);
          expect(await packs.listLuckyDrawEvents({})).toHaveLength(0);

          const ev = await post('/admin/lucky-draw/events', eventBody());
          const eventId = ev.data.id as string;
          for (const body of [
            cardPrizeBody(eventId, { card_handle: 'no-such-card' }),
            creditPrizeBody(eventId, { credit_myr: 999_999 }),
            creditPrizeBody(eventId, { kind: 'cash' }),
          ]) {
            expect((await post('/admin/lucky-draw/prizes', body)).status).toBe(
              400,
            );
          }
          expect(await packs.listLuckyDrawPrizes({})).toHaveLength(0);

          // No prizes yet: publish is refused and the event stays a draft.
          const empty = await post(
            `/admin/lucky-draw/events/${eventId}/publish`,
            { reason: 'too early' },
          );
          expect(empty.status).toBe(400);
          expect(
            (await packs.listLuckyDrawEvents({ id: eventId }))[0].status,
          ).toBe('draft');
          expect(
            (
              await post('/admin/lucky-draw/events/ldev_missing/publish', {
                reason: 'x',
              })
            ).status,
          ).toBe(404);
        });

        it('lists entrants, shows a ticket history, and cancel refunds', async () => {
          const { cardId } = await publishedEvent();
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
          await fund('cus_ld_a', 100);
          await fund('cus_ld_b', 100);
          const enter = (customerId: string, tickets: number) =>
            packs.enterLuckyDraw({ customerId, prizeId: cardId, tickets });
          await enter('cus_ld_a', 10);
          await enter('cus_ld_b', 30);
          await enter('cus_ld_a', 15);

          const entries = await get(
            `/admin/lucky-draw/prizes/${cardId}/entries`,
          );
          expect(entries.status).toBe(200);
          expect(entries.data).toEqual({
            entries: [
              { customer_id: 'cus_ld_b', tickets: 30 },
              { customer_id: 'cus_ld_a', tickets: 25 },
            ],
          });
          const overview = await get('/admin/lucky-draw');
          expect(overview.data.events[0].prizes[0]).toMatchObject({
            id: cardId,
            total_tickets: 55,
            entrant_count: 2,
          });
          expect(
            (await get('/admin/lucky-draw/prizes/ldpz_missing/entries')).status,
          ).toBe(404);

          const before = await get(
            '/admin/lucky-draw/tickets?customer_id=cus_ld_a',
          );
          expect(before.status).toBe(200);
          expect(before.data.balance).toBe(75);
          expect(before.data.rows).toHaveLength(3);
          expect(before.data.rows[0]).toMatchObject({
            delta: -15,
            reason: 'entry',
          });
          expect((await get('/admin/lucky-draw/tickets')).status).toBe(400);

          const cancelled = await post(
            `/admin/lucky-draw/prizes/${cardId}/cancel`,
            { reason: 'withdrawn' },
          );
          expect(cancelled.status).toBe(200);
          expect(cancelled.data).toEqual({ refunded: 2 });
          const after = await get(
            '/admin/lucky-draw/tickets?customer_id=cus_ld_a',
          );
          expect(after.data.balance).toBe(100);
          expect(after.data.rows[0]).toMatchObject({
            delta: 25,
            reason: 'refund',
          });
          // A second cancel is refused.
          expect(
            (
              await post(`/admin/lucky-draw/prizes/${cardId}/cancel`, {
                reason: 'again',
              })
            ).status,
          ).toBe(400);
        });

        it('needs an admin login', async () => {
          expect((await get('/admin/lucky-draw', {})).status).toBe(401);
          expect(
            (
              await unwrapResponse(
                api.post('/admin/lucky-draw/events', eventBody()),
              )
            ).status,
          ).toBe(401);
        });
      });

      describe('store API', () => {
        let packs: PacksModuleService;
        let adminHeaders: Record<string, string>;
        let storeHeaders: Record<string, string>;
        let ada: { token: string; id: string };
        let bo: { token: string; id: string };

        const authed = (token: string): Record<string, string> => ({
          ...storeHeaders,
          authorization: `Bearer ${token}`,
        });
        const adaHeaders = () => authed(ada.token);
        const get = (path: string, headers: Record<string, string>) =>
          unwrapResponse(api.get(path, { headers }));
        const enter = (
          prizeId: string,
          body: unknown,
          headers: Record<string, string>,
        ) =>
          unwrapResponse(
            api.post(`/store/lucky-draw/prizes/${prizeId}/enter`, body, {
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
          // The store create route takes no first_name; the feed prints it.
          await container
            .resolve(Modules.CUSTOMER)
            .updateCustomers(id, { first_name: firstName });
          return { token, id };
        };

        // A funded entrant: one settled top-up (the entry gate) and tickets.
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

        const adminPost = (path: string, body: unknown) =>
          unwrapResponse(api.post(path, body, { headers: adminHeaders }));

        // A live old-rule event (opened an hour ago, draws in 48h) with one
        // credit prize. Seeded: a publish now makes a one_winner event.
        const publishLive = async (prize: Record<string, unknown> = {}) => {
          const endsAt = new Date(Date.now() + 48 * HOUR);
          const [ev] = await packs.createLuckyDrawEvents([
            {
              name: 'November Lucky Draw',
              starts_at: new Date(Date.now() - HOUR),
              ends_at: endsAt,
              status: 'published',
              created_by: 'user_t',
            },
          ]);
          const [created] = await packs.createLuckyDrawPrizes([
            {
              event_id: ev.id,
              kind: 'credit',
              credit_myr: 25,
              title: 'RM 25 credit',
              image_url: '/cdn/ld-credit.webp',
              sort: 1,
              draw_at: endsAt,
              ...commitDrawSeed(process.env.LUCKY_DRAW_SEED_SECRET!),
              ...prize,
            },
          ]);
          return { eventId: ev.id, prizeId: created.id };
        };

        // A published event straight from the module, for windows the admin
        // routes would refuse (already over).
        const publishedPastEvent = async (
          name: string,
          startedDaysAgo: number,
          endedDaysAgo: number,
        ) => {
          const [ev] = await packs.createLuckyDrawEvents([
            {
              name,
              starts_at: new Date(Date.now() - startedDaysAgo * 24 * HOUR),
              ends_at: new Date(Date.now() - endedDaysAgo * 24 * HOUR),
              status: 'published',
              created_by: 'user_t',
            },
          ]);
          await packs.createLuckyDrawPrizes([
            {
              event_id: ev.id,
              kind: 'credit',
              credit_myr: 5,
              title: `${name} prize`,
              image_url: '/cdn/past.webp',
              draw_at: new Date(Date.now() - endedDaysAgo * 24 * HOUR),
              seed_nonce: 'nonce',
              seed_hash: 'hash',
            },
          ]);
        };

        const drawAfter = async (hours: number) => {
          const res = await packs.drawDueLuckyDrawPrizes({
            now: new Date(Date.now() + hours * HOUR),
          });
          expect(res.failed).toBe(0);
          return res;
        };

        // Every key name anywhere in a JSON value.
        const allKeys = (value: unknown): string[] =>
          Array.isArray(value)
            ? value.flatMap(allKeys)
            : value && typeof value === 'object'
              ? Object.entries(value).flatMap(([k, v]) => [k, ...allKeys(v)])
              : [];

        beforeEach(async () => {
          // Module state outlives the per-test database reset.
          clearLuckyDrawCache();
          clearFxDisplayCache();
          const container = getContainer();
          packs = container.resolve<PacksModuleService>(PACKS_MODULE);
          const key = await container.resolve(Modules.API_KEY).createApiKeys({
            title: 'lucky-draw-store-test',
            type: 'publishable',
            created_by: 'lucky-draw-store-test',
          });
          storeHeaders = { 'x-publishable-api-key': key.token };
          adminHeaders = {
            authorization: `Bearer ${await mintSuperAdmin(
              container,
              api,
              'ld-store-admin@test.dev',
              PASSWORD,
            )}`,
          };
          await packs.createFxRates([
            { pair: 'USD_MYR', rate: 4, source: 'test' },
          ]);
          await packs.createCards([
            {
              handle: CARD_HANDLE,
              name: 'Lucky Draw Test Card',
              set: 'Test Set',
              grader: 'PSA',
              grade: '10',
              market_value: 50,
              market_multiplier: 1.2,
              image: '/cdn/ld-card.webp',
              slab_image: '/cdn/ld-card-slab.webp',
            },
          ]);
          ada = await registerCustomer('ld-ada@test.dev', 'Ada');
          bo = await registerCustomer('ld-bo@test.dev', 'Bo');
        });

        it('GET /store/lucky-draw lists live prizes with my tickets, top 10 and no draw seed', async () => {
          const { prizeId } = await publishLive();
          await fund(ada.id, 100);
          const entered = await enter(prizeId, { tickets: 30 }, adaHeaders());
          expect(entered.status).toBe(200);
          expect(entered.data).toMatchObject({
            entered: true,
            balance: 70,
            myTickets: 30,
          });

          const [row] = await packs.listLuckyDrawPrizes({ id: prizeId });
          const seed = deriveDrawSeed(
            process.env.LUCKY_DRAW_SEED_SECRET!,
            row.seed_nonce!,
          );
          const res = await get('/store/lucky-draw', adaHeaders());
          expect(res.status).toBe(200);
          expect(res.data.balance).toBe(70);
          expect(res.data.event).toMatchObject({
            name: 'November Lucky Draw',
          });
          expect(res.data.prizes).toHaveLength(1);
          expect(res.data.prizes[0]).toMatchObject({
            id: prizeId,
            kind: 'credit',
            title: 'RM 25 credit',
            image: '/cdn/ld-credit.webp',
            value_myr: 25,
            my_tickets: 30,
            total_tickets: 30,
            entrant_count: 1,
            seed_hash: row.seed_hash,
            result: null,
          });
          expect(res.data.prizes[0].top).toEqual([
            {
              person: expect.objectContaining({ who: 'Ada' }),
              tickets: 30,
            },
          ]);
          expect(JSON.stringify(res.data)).not.toContain(seed);
          // the same secret must not appear on any other store route before the draw
          for (const path of [
            '/store/lucky-draw/me',
            '/store/lucky-draw/results',
          ])
            expect(
              JSON.stringify((await get(path, adaHeaders())).data),
            ).not.toContain(seed);
        });

        it('shows the top 10 most-tickets-first, with persons that carry no draw seed', async () => {
          const { prizeId } = await publishLive();
          // 12 synthetic entrants (100, 92, ... 12 tickets) plus Ada with 55.
          for (let i = 0; i < 12; i += 1) {
            const id = `cus_ld_top_${String(i).padStart(2, '0')}`;
            await fund(id, 200);
            await packs.enterLuckyDraw({
              customerId: id,
              prizeId,
              tickets: 100 - i * 8,
            });
          }
          await fund(ada.id, 100);
          await enter(prizeId, { tickets: 55 }, adaHeaders());

          const res = await get('/store/lucky-draw', adaHeaders());
          const prize = res.data.prizes[0];
          expect(prize.entrant_count).toBe(13);
          expect(prize.top).toHaveLength(10);
          const counts = prize.top.map((t: { tickets: number }) => t.tickets);
          expect(counts).toEqual([...counts].sort((a, b) => b - a));
          expect(counts[0]).toBe(100);
          // Ada's 55 is 7th of 13: 100 92 84 76 68 60 55 52 44 36
          expect(prize.top[6].person.who).toBe('Ada');
          for (const t of prize.top) {
            expect(Object.keys(t.person).sort()).toEqual([
              'avatar_url',
              'face_seed',
              'frame_url',
              'who',
            ]);
          }
          // No person anywhere is described by a `seed` key.
          expect(allKeys(res.data)).not.toContain('seed');
        });

        it('serves the shared page from cache but my tickets and balance live', async () => {
          const { prizeId } = await publishLive();
          await fund(ada.id, 100);
          const first = await get('/store/lucky-draw', adaHeaders());
          expect(first.data.prizes[0]).toMatchObject({
            my_tickets: 0,
            total_tickets: 0,
          });
          await enter(prizeId, { tickets: 10 }, adaHeaders());
          const second = await get('/store/lucky-draw', adaHeaders());
          // Per request: balance and my_tickets move at once.
          expect(second.data.balance).toBe(90);
          expect(second.data.prizes[0].my_tickets).toBe(10);
          // Shared: the totals are the cached ones.
          expect(second.data.prizes[0].total_tickets).toBe(0);
          clearLuckyDrawCache();
          const third = await get('/store/lucky-draw', adaHeaders());
          expect(third.data.prizes[0].total_tickets).toBe(10);
        });

        it('picks the live event, else one that ended within 7 days, else null', async () => {
          const none = await get('/store/lucky-draw', adaHeaders());
          expect(none.status).toBe(200);
          expect(none.data).toEqual({
            balance: 0,
            event: null,
            prizes: [],
            next_event: null,
          });

          // Ended 10 days ago: too old.
          await publishedPastEvent('Old draw', 12, 10);
          clearLuckyDrawCache();
          expect(
            (await get('/store/lucky-draw', adaHeaders())).data.event,
          ).toBeNull();

          // Ended 2 days ago: still shown, with its prizes.
          await publishedPastEvent('Recent draw', 4, 2);
          clearLuckyDrawCache();
          const shown = await get('/store/lucky-draw', adaHeaders());
          expect(shown.data.event).toMatchObject({ name: 'Recent draw' });
          expect(shown.data.prizes[0]).toMatchObject({
            title: 'Recent draw prize',
          });

          // A live event wins over the recent one.
          await publishLive();
          clearLuckyDrawCache();
          const live = await get('/store/lucky-draw', adaHeaders());
          expect(live.data.event).toMatchObject({
            name: 'November Lucky Draw',
          });
          expect(live.data.prizes).toHaveLength(1);
        });

        it('prices a card prize at its current value with the slab image', async () => {
          await publishLive({
            kind: 'card',
            card_handle: CARD_HANDLE,
            credit_myr: undefined,
            title: 'Test card',
            image_url: undefined,
          });
          const res = await get('/store/lucky-draw', adaHeaders());
          expect(res.data.prizes[0]).toMatchObject({
            kind: 'card',
            value_myr: 240,
            image: '/cdn/ld-card-slab.webp',
          });
        });

        it('POST enter returns 200 { entered:false, reason:"no_topup" } for a never-topped-up account', async () => {
          const { prizeId } = await publishLive();
          await packs.createLuckyDrawTickets([
            {
              customer_id: bo.id,
              delta: 20,
              reason: 'task_claim',
              ref: 'claim-bo',
            },
          ]);
          const res = await enter(prizeId, { tickets: 5 }, authed(bo.token));
          expect(res.status).toBe(200);
          expect(res.data).toEqual({ entered: false, reason: 'no_topup' });
          expect(await packs.listLuckyDrawEntries({})).toHaveLength(0);
        });

        it('POST enter refuses a missing prize with 200 and ignores a client clock', async () => {
          const { prizeId } = await publishLive();
          await fund(ada.id, 10);
          const missing = await enter(
            'ldpz_nope',
            { tickets: 1 },
            adaHeaders(),
          );
          expect(missing.status).toBe(200);
          expect(missing.data).toEqual({ entered: false, reason: 'not_found' });
          // A `now` far past the draw time must not reach the service.
          const res = await enter(
            prizeId,
            { tickets: 1, now: new Date(Date.now() + 90 * 24 * HOUR) },
            adaHeaders(),
          );
          expect(res.status).toBe(200);
          expect(res.data.entered).toBe(true);
        });

        it('POST enter with tickets 0 is a 400', async () => {
          const { prizeId } = await publishLive();
          await fund(ada.id, 10);
          for (const body of [
            { tickets: 0 },
            { tickets: -3 },
            { tickets: 1.5 },
            { tickets: '2' },
            {},
          ]) {
            expect((await enter(prizeId, body, adaHeaders())).status).toBe(400);
          }
          expect(await packs.listLuckyDrawEntries({})).toHaveLength(0);
        });

        it('GET /store/lucky-draw/balance and /me show tickets, history and entry status', async () => {
          const { prizeId } = await publishLive();
          await fund(ada.id, 100);
          await enter(prizeId, { tickets: 40 }, adaHeaders());

          const balance = await get('/store/lucky-draw/balance', adaHeaders());
          expect(balance.status).toBe(200);
          expect(balance.data).toEqual({ balance: 60 });

          const me = await get('/store/lucky-draw/me', adaHeaders());
          expect(me.status).toBe(200);
          expect(me.data.balance).toBe(60);
          expect(me.data.history).toEqual([
            { delta: -40, reason: 'entry', created_at: expect.any(String) },
            {
              delta: 100,
              reason: 'task_claim',
              created_at: expect.any(String),
            },
          ]);
          expect(me.data.entries).toEqual([
            {
              prize_id: prizeId,
              title: 'RM 25 credit',
              image: '/cdn/ld-credit.webp',
              my_tickets: 40,
              draw_at: expect.any(String),
              status: 'open',
            },
          ]);

          // Bo sees none of Ada's tickets.
          const boMe = await get('/store/lucky-draw/me', authed(bo.token));
          expect(boMe.data).toEqual({ balance: 0, history: [], entries: [] });

          const cancelled = await adminPost(
            `/admin/lucky-draw/prizes/${prizeId}/cancel`,
            { reason: 'withdrawn' },
          );
          expect(cancelled.status).toBe(200);
          const after = await get('/store/lucky-draw/me', adaHeaders());
          expect(after.data.balance).toBe(100);
          expect(after.data.entries[0]).toMatchObject({
            my_tickets: 40,
            status: 'cancelled',
          });
          // The cancelled prize is off the live page.
          clearLuckyDrawCache();
          expect(
            (await get('/store/lucky-draw', adaHeaders())).data.prizes,
          ).toEqual([]);
        });

        it('after the draw, the result shows the seed and the full entry list', async () => {
          const { prizeId } = await publishLive();
          await fund(ada.id, 100);
          await enter(prizeId, { tickets: 30 }, adaHeaders());

          // Not drawn yet: 404.
          expect(
            (await get(`/store/lucky-draw/results/${prizeId}`, adaHeaders()))
              .status,
          ).toBe(404);
          expect(
            (await get('/store/lucky-draw/results', adaHeaders())).data,
          ).toEqual({ results: [], next_before: null });

          await drawAfter(49);
          // The 404 is remembered ~2 s (the draw-minute polls); skip the wait.
          clearLuckyDrawCache();

          const res = await get(
            `/store/lucky-draw/results/${prizeId}`,
            adaHeaders(),
          );
          expect(res.status).toBe(200);
          expect(res.data.result.seed).toMatch(/^[0-9a-f]{64}$/);
          expect(res.data.entries).toHaveLength(1);
          expect(res.data.entries[0]).toMatchObject({
            person: expect.objectContaining({ who: 'Ada' }),
            tickets: 30,
          });
          expect(res.data.result).toMatchObject({
            prize_id: prizeId,
            title: 'RM 25 credit',
            image: '/cdn/ld-credit.webp',
            value_myr: 25,
            winner: expect.objectContaining({ who: 'Ada' }),
            winner_tickets: 30,
            total_tickets: 30,
            entrant_count: 1,
            seed_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
          });
          expect(res.data.ticket_index).toBeGreaterThanOrEqual(0);
          expect(res.data.ticket_index).toBeLessThan(30);

          // The published hash commits to the revealed seed.
          expect(drawSeedHash(res.data.result.seed)).toBe(
            res.data.result.seed_hash,
          );

          const list = await get('/store/lucky-draw/results', adaHeaders());
          expect(list.data.results).toHaveLength(1);
          expect(list.data.results[0].seed).toBe(res.data.result.seed);
          expect(list.data.next_before).toBeNull();

          // The live page now carries the result for the drawn prize.
          clearLuckyDrawCache();
          const page = await get('/store/lucky-draw', adaHeaders());
          expect(page.data.prizes[0].result.seed).toBe(res.data.result.seed);
          expect(page.data.prizes[0]).toMatchObject({
            total_tickets: 30,
            entrant_count: 1,
          });
        });

        it('marks each entrant won or lost from the stored result', async () => {
          const { prizeId } = await publishLive();
          await fund(ada.id, 100);
          await fund(bo.id, 100);
          await enter(prizeId, { tickets: 30 }, adaHeaders());
          await enter(prizeId, { tickets: 20 }, authed(bo.token));
          await drawAfter(49);

          const [result] = await packs.listLuckyDrawResults({
            prize_id: prizeId,
          });
          const statusOf = async (token: string) =>
            (await get('/store/lucky-draw/me', authed(token))).data.entries[0]
              .status;
          const adaWon = result.winner_customer_id === ada.id;
          expect(await statusOf(ada.token)).toBe(adaWon ? 'won' : 'lost');
          expect(await statusOf(bo.token)).toBe(adaWon ? 'lost' : 'won');

          const detail = await get(
            `/store/lucky-draw/results/${prizeId}`,
            adaHeaders(),
          );
          // Stored draw order: sorted by customer id.
          const order = [ada.id, bo.id].sort();
          expect(
            detail.data.entries.map((e: { tickets: number }) => e.tickets),
          ).toEqual(order.map((id) => (id === ada.id ? 30 : 20)));
          expect(detail.data.result.entrant_count).toBe(2);
        });

        it('pages results newest first with a next_before cursor', async () => {
          const first = await publishLive();
          await drawAfter(49);
          // A second event once the first has drawn.
          await new Promise((r) => setTimeout(r, 15));
          const second = await publishLive({ title: 'Second prize' });
          await drawAfter(49);

          const ids = (data: { results: { prize_id: string }[] }) =>
            data.results.map((r) => r.prize_id);
          const page1 = await get(
            '/store/lucky-draw/results?limit=1',
            adaHeaders(),
          );
          expect(page1.status).toBe(200);
          expect(ids(page1.data)).toEqual([second.prizeId]);
          expect(page1.data.next_before).toEqual(expect.any(String));

          const page2 = await get(
            `/store/lucky-draw/results?limit=1&before=${encodeURIComponent(page1.data.next_before)}`,
            adaHeaders(),
          );
          expect(ids(page2.data)).toEqual([first.prizeId]);
          expect(page2.data.next_before).toBeNull();

          for (const query of [
            'limit=0',
            'limit=51',
            'limit=x',
            'before=soon',
          ]) {
            expect(
              (await get(`/store/lucky-draw/results?${query}`, adaHeaders()))
                .status,
            ).toBe(400);
          }
        });

        it('every /store/lucky-draw route is 401 without a customer bearer', async () => {
          const { prizeId } = await publishLive();
          for (const path of [
            '/store/lucky-draw',
            '/store/lucky-draw/balance',
            '/store/lucky-draw/me',
            '/store/lucky-draw/results',
            `/store/lucky-draw/results/${prizeId}`,
          ]) {
            expect((await get(path, storeHeaders)).status).toBe(401);
          }
          expect(
            (await enter(prizeId, { tickets: 1 }, storeHeaders)).status,
          ).toBe(401);
        });
      });
    });
  },
});

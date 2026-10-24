// Test-only seed secret: publish and draw refuse without one (later tasks).
process.env.LUCKY_DRAW_SEED_SECRET ??= 'test-lucky-draw-seed-secret';

import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import {
  deriveDrawSeed,
  drawSeedHash,
} from '../../src/modules/packs/lucky-draw';
import { clearFxDisplayCache } from '../../src/modules/packs/pricing';
import { mintSuperAdmin, unwrapResponse } from './utils';

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

        // Event + one card prize + one credit prize, published, through the routes.
        const publishedEvent = async () => {
          const ev = await post('/admin/lucky-draw/events', eventBody());
          expect(ev.status).toBe(200);
          const eventId = ev.data.id as string;
          const card = await post(
            '/admin/lucky-draw/prizes',
            cardPrizeBody(eventId),
          );
          const credit = await post(
            '/admin/lucky-draw/prizes',
            creditPrizeBody(eventId),
          );
          expect([card.status, credit.status]).toEqual([200, 200]);
          const published = await post(
            `/admin/lucky-draw/events/${eventId}/publish`,
            { reason: 'go live' },
          );
          expect(published.status).toBe(200);
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
          const { eventId, cardId } = await publishedEvent();
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
            creditPrizeBody(eventId, { image_url: null }),
            creditPrizeBody(eventId, {
              draw_at: new Date(Date.now() + 99 * HOUR).toISOString(),
            }),
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
    });
  },
});

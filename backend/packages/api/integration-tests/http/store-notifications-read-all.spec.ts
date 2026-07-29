// integration-tests/http/store-notifications-read-all.spec.ts
// TDD: RED first — POST /store/notifications/read-all does not exist yet (404).
// Tests:
//   (auth)     no bearer → 401.
//   (positive) marks every unread row for the caller; unread_count → 0.
//   (idempotent) a second call marks 0, never re-attempts already-read ids
//                (proves the alreadyRead filter runs, not just the count),
//                and leaves the original read_at timestamps unchanged.
//   (IDOR)     B's rows are untouched by A's read-all, including when A's
//              body forges customer_id/notification_ids pointing at B.
import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import { unwrapResponse } from './utils';
import { CUSTOMER_FEED_CHANNEL } from '../../src/modules/packs/notify-feed';

jest.setTimeout(120 * 1000);

const PASSWORD = 'read-all-test-password-1';

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('POST /store/notifications/read-all', () => {
      let storeHeaders: Record<string, string>;
      let tokenA: string;
      let customerIdA: string;
      let customerIdB: string;

      beforeEach(async () => {
        const container = getContainer();

        const apiKeyModule = container.resolve(Modules.API_KEY);
        const key = await apiKeyModule.createApiKeys({
          title: 'read-all-test',
          type: 'publishable',
          created_by: 'read-all-test',
        });
        storeHeaders = { 'x-publishable-api-key': key.token };

        const regA = await api.post('/auth/customer/emailpass/register', {
          email: 'read-all-a@test.dev',
          password: PASSWORD,
        });
        await api.post(
          '/store/customers',
          { email: 'read-all-a@test.dev' },
          {
            headers: {
              ...storeHeaders,
              authorization: `Bearer ${regA.data.token}`,
            },
          },
        );
        const loginA = await api.post('/auth/customer/emailpass', {
          email: 'read-all-a@test.dev',
          password: PASSWORD,
        });
        tokenA = loginA.data.token;
        customerIdA = JSON.parse(
          Buffer.from(tokenA.split('.')[1], 'base64').toString('utf8'),
        ).actor_id as string;

        const regB = await api.post('/auth/customer/emailpass/register', {
          email: 'read-all-b@test.dev',
          password: PASSWORD,
        });
        await api.post(
          '/store/customers',
          { email: 'read-all-b@test.dev' },
          {
            headers: {
              ...storeHeaders,
              authorization: `Bearer ${regB.data.token}`,
            },
          },
        );
        const loginB = await api.post('/auth/customer/emailpass', {
          email: 'read-all-b@test.dev',
          password: PASSWORD,
        });
        customerIdB = JSON.parse(
          Buffer.from(loginB.data.token.split('.')[1], 'base64').toString('utf8'),
        ).actor_id as string;
        expect(customerIdB).toBeTruthy();

        // Three unread rows for A, two for B.
        const notif = container.resolve(Modules.NOTIFICATION);
        for (const template of [
          'vip_level_up',
          'commission_matured',
          'delivery_status',
        ]) {
          await notif.createNotifications([
            {
              to: customerIdA,
              receiver_id: customerIdA,
              channel: CUSTOMER_FEED_CHANNEL,
              template,
              data: {},
            },
          ]);
        }
        for (const template of ['vip_level_up', 'topup_credited']) {
          await notif.createNotifications([
            {
              to: customerIdB,
              receiver_id: customerIdB,
              channel: CUSTOMER_FEED_CHANNEL,
              template,
              data: {},
            },
          ]);
        }
      });

      const authed = (token: string) => ({
        ...storeHeaders,
        authorization: `Bearer ${token}`,
      });

      it('(auth) returns 401 without a bearer token', async () => {
        const res = await unwrapResponse(
          api.post('/store/notifications/read-all', {}, { headers: storeHeaders }),
        );
        expect(res.status).toBe(401);
      });

      it('(positive) marks every unread row and zeroes unread_count', async () => {
        const before = await unwrapResponse(
          api.get('/store/notifications', { headers: authed(tokenA) }),
        );
        expect(before.data.unread_count).toBe(3);

        const res = await unwrapResponse(
          api.post('/store/notifications/read-all', {}, { headers: authed(tokenA) }),
        );
        expect(res.status).toBe(200);
        expect(res.data.marked).toBe(3);
        expect(res.data.read_at).toBeTruthy();

        const after = await unwrapResponse(
          api.get('/store/notifications', { headers: authed(tokenA) }),
        );
        expect(after.data.unread_count).toBe(0);
        for (const n of after.data.notifications) {
          expect(n.read_at).toBeTruthy();
        }
      });

      it('(idempotent) a second call marks nothing more, never re-attempts already-read ids, and leaves read_at unchanged', async () => {
        const first = await unwrapResponse(
          api.post('/store/notifications/read-all', {}, { headers: authed(tokenA) }),
        );
        expect(first.status).toBe(200);
        expect(first.data.marked).toBe(3);

        const beforeSecond = await unwrapResponse(
          api.get('/store/notifications', { headers: authed(tokenA) }),
        );
        const readAtBefore = new Map(
          (beforeSecond.data.notifications as Array<{ id: string; read_at: string | null }>).map(
            (n) => [n.id, n.read_at],
          ),
        );
        for (const [, readAt] of readAtBefore) {
          expect(readAt).toBeTruthy();
        }

        // A correct alreadyRead filter means toCreate is empty on the second
        // call, so createNotificationReads must never be invoked at all. If
        // the filter were deleted, all 3 already-read ids would be
        // resubmitted, hit the unique-index recovery path, and still report
        // marked === 0 (the recovery path self-heals the count) — so only a
        // call-was-never-made assertion actually distinguishes the two.
        const container = getContainer();
        const packs = container.resolve('packs') as {
          createNotificationReads: (...args: unknown[]) => Promise<unknown>;
        };
        const createSpy = jest.spyOn(packs, 'createNotificationReads');

        const second = await unwrapResponse(
          api.post('/store/notifications/read-all', {}, { headers: authed(tokenA) }),
        );
        expect(second.status).toBe(200);
        expect(second.data.marked).toBe(0);
        expect(createSpy).not.toHaveBeenCalled();
        createSpy.mockRestore();

        const afterSecond = await unwrapResponse(
          api.get('/store/notifications', { headers: authed(tokenA) }),
        );
        const readAtAfter = new Map(
          (afterSecond.data.notifications as Array<{ id: string; read_at: string | null }>).map(
            (n) => [n.id, n.read_at],
          ),
        );
        for (const [id, readAt] of readAtBefore) {
          expect(readAtAfter.get(id)).toBe(readAt);
        }
      });

      it("(IDOR) A's read-all never touches B's rows", async () => {
        await unwrapResponse(
          api.post('/store/notifications/read-all', {}, { headers: authed(tokenA) }),
        );

        const container = getContainer();
        const packs = container.resolve('packs') as {
          listNotificationReads: (
            f: Record<string, unknown>,
            c: Record<string, unknown>,
          ) => Promise<Array<{ customer_id: string; notification_id: string }>>;
        };
        const bReads = await packs.listNotificationReads(
          { customer_id: customerIdB },
          { take: 100 },
        );
        expect(bReads).toHaveLength(0);
      });

      it("(IDOR) a forged body targeting B's customer_id/notification_ids is ignored — only A's own rows are marked", async () => {
        const container = getContainer();
        const notif = container.resolve(Modules.NOTIFICATION);
        const bRows = await notif.listNotifications(
          { receiver_id: customerIdB, channel: CUSTOMER_FEED_CHANNEL },
          { take: 10 },
        );
        expect(bRows.length).toBeGreaterThan(0);
        const bNotificationIds = bRows.map((r: { id: string }) => r.id);

        // Owner scoping must be derived ONLY from req.auth_context.actor_id.
        // Send a body that tries to redirect the write set at B — via both a
        // forged customer_id and a forged notification_ids list — while
        // authenticating as A.
        const res = await unwrapResponse(
          api.post(
            '/store/notifications/read-all',
            { customer_id: customerIdB, notification_ids: bNotificationIds },
            { headers: authed(tokenA) },
          ),
        );
        expect(res.status).toBe(200);
        // A still has 3 unread rows of her own — the forged body must not
        // suppress or redirect them.
        expect(res.data.marked).toBe(3);

        const packs = container.resolve('packs') as {
          listNotificationReads: (
            f: Record<string, unknown>,
            c: Record<string, unknown>,
          ) => Promise<Array<{ customer_id: string; notification_id: string }>>;
        };
        const bReads = await packs.listNotificationReads(
          { customer_id: customerIdB },
          { take: 100 },
        );
        expect(bReads).toHaveLength(0);

        const aReads = await packs.listNotificationReads(
          { customer_id: customerIdA },
          { take: 100 },
        );
        expect(aReads).toHaveLength(3);
        const aReadIds = new Set(aReads.map((r) => r.notification_id));
        for (const bId of bNotificationIds) {
          expect(aReadIds.has(bId)).toBe(false);
        }
      });
    });
  },
});

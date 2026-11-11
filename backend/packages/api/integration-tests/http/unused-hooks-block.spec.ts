import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

// Mercur's /hooks/payout and core's /hooks/payment/:provider (audit
// 2026-11-11): no payment provider is configured, yet each anonymous POST
// queued an event on the single event worker. Both are closed; the gateway
// callbacks under /hooks/<gateway>/* must still reach their handlers.

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api }) => {
    describe('unused payment hooks', () => {
      const post = (path: string) =>
        unwrapResponse(api.post(path, { any: 'thing' }));

      it.each([
        '/hooks/payout',
        '/hooks/payout?x=1',
        '/hooks/payment/stripe_stripe',
        '/hooks/payment/pp_system_default',
      ])('404s POST %s', async (path) => {
        expect((await post(path)).status).toBe(404);
      });

      it('still routes the TGPay deposit callback to its handler', async () => {
        expect((await post('/hooks/tgpay/deposit')).status).not.toBe(404);
      });
    });
  },
});

import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { fakeGateway } from '../../src/modules/packs/fake-gateway';
import { setActiveGateway } from '../../src/modules/packs/gateway';
import { mintSuperAdmin, unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

// Deposits' Credit from gateway entry (2026-11-22), end to end: the real
// migrations (gateway_adjustment_entry_id + its unique index), the admin
// route, its RBAC entry and the credit. A real case: a 75 USDT
// order at RM 306.45 that GlobePay365 marked Verify Fail, then booked the
// 75.36 USDT that arrived as manual entry MD….

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('POST /admin/payments/deposits/:id/credit-from-entry', () => {
      const env = { ...process.env };
      let adminToken: string;

      beforeEach(async () => {
        fakeGateway.reset();
        setActiveGateway(null);
        process.env.GATEWAY_ENABLED = 'true';
        process.env.PAYMENT_GATEWAY = 'fake';
        fakeGateway.script({
          getDepositDetail: (() => {
            const asked = fakeGateway.calls.depositDetails.at(-1) ?? '';
            return asked.startsWith('PC-')
              ? { state: 'failed', amount: 0, transactionId: 'D-ORDER' }
              : {
                  state: 'success',
                  amount: 75.36,
                  netAmount: 74.61,
                  statusId: 6,
                  transactionId: `D-${asked}`,
                };
          }) as never,
        });
        adminToken = await mintSuperAdmin(
          getContainer(),
          api,
          'cfe-admin@test.dev',
          'cfe-test-password-1',
        );
      });
      afterAll(() => {
        process.env = env;
        setActiveGateway(null);
      });

      const post = (
        id: string,
        body: Record<string, unknown>,
        withAuth = true,
      ) =>
        unwrapResponse(
          api.post(
            `/admin/payments/deposits/${id}/credit-from-entry`,
            body,
            withAuth
              ? { headers: { authorization: `Bearer ${adminToken}` } }
              : {},
          ),
        );

      it('credits what arrived once, through the real schema and route', async () => {
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        const [row] = await packs.createGatewayDeposits([
          {
            merchant_transaction_id: 'PC-CFE-HTTP',
            customer_id: 'cus_cfe_http',
            amount_requested: 306.45,
            gateway_amount: 75,
            currency: 'USDT',
            payment_method_code: 'UTRC',
            gateway_transaction_id: 'D-ORDER-HTTP',
            gateway: 'fake',
            status: 'expired',
          },
        ]);
        const body = { ref: 'MD-HTTP-1', reason: 'GP365 confirmed 75.36 USDT' };

        expect((await post(row.id, body, false)).status).toBe(401);
        expect((await post(row.id, { ref: 'MD-HTTP-1' })).status).toBe(400);

        const ok = await post(row.id, body);
        expect(ok.status).toBe(200);
        expect(ok.data).toEqual({
          credited: true,
          replayed: false,
          amount: 307.92,
          ref: 'MD-HTTP-1',
          entryId: 'D-MD-HTTP-1',
        });

        const [after] = await packs.listGatewayDeposits(
          { id: row.id },
          { take: 1 },
        );
        expect(after.status).toBe('settled');
        expect(after.gateway_adjustment_entry_id).toBe('D-MD-HTTP-1');

        // A second click moves nothing.
        const again = await post(row.id, body);
        expect(again.status).toBeGreaterThanOrEqual(400);
        const credits = await packs.listCreditTransactions(
          { customer_id: 'cus_cfe_http' },
          { take: 10 },
        );
        expect(credits).toHaveLength(1);
        expect(Number(credits[0].amount)).toBe(307.92);

        // The migration's unique index: one entry id backs one row.
        await expect(
          packs.createGatewayDeposits([
            {
              merchant_transaction_id: 'PC-CFE-DUP',
              customer_id: 'cus_cfe_dup',
              amount_requested: 1,
              payment_method_code: 'UTRC',
              gateway: 'fake',
              status: 'expired',
              gateway_adjustment_entry_id: 'D-MD-HTTP-1',
            } as never,
          ]),
        ).rejects.toThrow();
      });
    });
  },
});

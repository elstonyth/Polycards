import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { mintSuperAdmin, unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

// POST/GET /admin/payments/fx against a REAL database: the fee is two
// bigNumber columns (numeric + raw_ jsonb sidecar) and a nullable switch, and
// only a real write-then-read proves the ORM stores and returns them so the
// quote prices at the operator's example (market 3.19, 0.5% each way).
const PASSWORD = 'payment-fx-fee-password-1'; // gitleaks:allow
const ADMIN_EMAIL = 'payment-fx-fee-admin@test.dev';

type FxState = {
  fee_enabled: boolean | null;
  deposit_fee_percent: number;
  payout_fee_percent: number;
  quote: {
    depositRate: number;
    payoutRate: number;
    feeEnabled: boolean;
  } | null;
  quote_error: string | null;
};

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('/admin/payments/fx fees', () => {
      let headers: { authorization: string };

      beforeEach(async () => {
        const token = await mintSuperAdmin(
          getContainer(),
          api,
          ADMIN_EMAIL,
          PASSWORD,
        );
        headers = { authorization: `Bearer ${token}` };
      });

      const save = async (body: Record<string, unknown>) =>
        unwrapResponse(
          api.post(
            '/admin/payments/fx',
            {
              currency: 'SGD',
              manual_override: true,
              manual_rate: 3.19,
              reason: 'payment-fx-fee spec',
              ...body,
            },
            { headers },
          ),
        );

      it('never configured: paused; then 0.5% each way prices 3.17405 / 3.20595; off = the mid both ways', async () => {
        const before = await unwrapResponse(
          api.get('/admin/payments/fx?currency=SGD', { headers }),
        );
        expect((before.data as FxState).quote).toBeNull();

        const on = await save({
          fee_enabled: true,
          deposit_fee_percent: 0.5,
          payout_fee_percent: 0.5,
        });
        expect(on.status).toBe(200);
        expect(on.data as FxState).toMatchObject({
          fee_enabled: true,
          deposit_fee_percent: 0.5,
          payout_fee_percent: 0.5,
          quote: {
            depositRate: 3.17405,
            payoutRate: 3.20595,
            feeEnabled: true,
          },
        });

        const off = await save({
          fee_enabled: false,
          deposit_fee_percent: 0.5,
          payout_fee_percent: 0.5,
        });
        expect(off.data as FxState).toMatchObject({
          fee_enabled: false,
          // Kept while off, so switching back on restores them.
          deposit_fee_percent: 0.5,
          quote: { depositRate: 3.19, payoutRate: 3.19, feeEnabled: false },
        });

        // Read back fresh, not from the POST's echo.
        const read = await unwrapResponse(
          api.get('/admin/payments/fx?currency=SGD', { headers }),
        );
        expect((read.data as FxState).payout_fee_percent).toBe(0.5);
      });

      it('refuses a fee over 20% or a missing switch, writing nothing', async () => {
        const tooBig = await save({
          fee_enabled: true,
          deposit_fee_percent: 25,
          payout_fee_percent: 0.5,
        });
        expect(tooBig.status).toBe(400);
        const noSwitch = await save({
          deposit_fee_percent: 0.5,
          payout_fee_percent: 0.5,
        });
        expect(noSwitch.status).toBe(400);
        const stringPin = await save({
          fee_enabled: true,
          deposit_fee_percent: 0.5,
          payout_fee_percent: 0.5,
          manual_override: 'true',
          manual_rate: 3.2,
        });
        expect(stringPin.status).toBe(400);
        const read = await unwrapResponse(
          api.get('/admin/payments/fx?currency=SGD', { headers }),
        );
        expect((read.data as FxState).fee_enabled).toBeNull();
      });
    });
  },
});

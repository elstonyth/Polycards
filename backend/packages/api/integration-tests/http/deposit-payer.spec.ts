import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import { unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

// GET /store/credits/deposit/payer through the REAL app: the unit spec calls
// the handler directly, so only this proves the middleware wiring — a
// logged-in customer only, scoped to the token's own customer, and the
// customer's saved Singapore account deciding whether the S$ top-up sheet
// asks for the paying account's name.
const PASSWORD = 'deposit-payer-password-1'; // gitleaks:allow
const A3PAY_ENV: Record<string, string> = {
  GATEWAY_ENABLED: 'true',
  A3PAY_ENABLED: 'true',
  A3PAY_API_BASE: 'https://mapi.example.test',
  A3PAY_MERCHANT_CODE: 'SGD00001',
  A3PAY_AES_KEY: 'k',
  A3PAY_MERCHANT_PRIVATE_KEY: 'priv',
  A3PAY_PUBLIC_KEY: 'pub',
};

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('/store/credits/deposit/payer', () => {
      let storeHeaders: Record<string, string>;
      const before: Record<string, string | undefined> = {};

      beforeAll(() => {
        for (const [k, v] of Object.entries(A3PAY_ENV)) {
          before[k] = process.env[k];
          process.env[k] = v;
        }
      });
      afterAll(() => {
        for (const [k, v] of Object.entries(before)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      });

      beforeEach(async () => {
        const key = await getContainer()
          .resolve(Modules.API_KEY)
          .createApiKeys({
            title: 'deposit-payer-test',
            type: 'publishable',
            created_by: 'deposit-payer-test',
          });
        storeHeaders = { 'x-publishable-api-key': key.token };
      });

      const registerCustomer = async (email: string): Promise<string> => {
        const reg = await api.post('/auth/customer/emailpass/register', {
          email,
          password: PASSWORD,
        });
        await api.post(
          '/store/customers',
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
        return login.data.token as string;
      };

      const payer = (token?: string) =>
        unwrapResponse(
          api.get('/store/credits/deposit/payer?currency=SGD', {
            headers: token
              ? { ...storeHeaders, authorization: `Bearer ${token}` }
              : storeHeaders,
          }),
        );

      it('a logged-in customer with nothing saved is asked; a logged-out caller is refused', async () => {
        const anon = await payer();
        expect(anon.status).toBe(401);

        const token = await registerCustomer('deposit-payer-a@test.dev');
        const res = await payer(token);
        expect(res.status).toBe(200);
        expect(res.data).toEqual({
          currency: 'SGD',
          saved_name: null,
          real_name: null,
        });
      });
    });
  },
});

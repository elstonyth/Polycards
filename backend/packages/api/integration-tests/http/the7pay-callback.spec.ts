import { createHmac } from 'node:crypto';
import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

// The 7 Pay callbacks against a booted server. The handlers are TGPay's
// (tgpay-callback.spec.ts covers them end to end); what only a booted app can
// prove is the Method 2 callback: that /hooks/the7pay/* really receives the
// raw request bytes (bodyParser.preserveRawBody in middlewares.ts), so an
// HMAC over exactly what was sent verifies and credits the ledger once.

const CUSTOMER_ID = 'cus_the7pay_integration';
const PK = 'pk-7-int';
const SK = 'sk-7-int';

process.env.GATEWAY_ENABLED = 'true';
process.env.PAYMENT_CALLBACK_BASE = 'https://backend.example.test';
process.env.THE7PAY_API_BASE = 'https://sandbox-api.the7pay.test/api/v1';
process.env.THE7PAY_PUBLIC_KEY = PK;
process.env.THE7PAY_SECRET_KEY = SK;
delete process.env.THE7PAY_CALLBACK_IPS;

const sign = (raw: string) =>
  createHmac('sha256', `${PK}${SK}`).update(raw, 'utf8').digest('hex');

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    const packs = () =>
      getContainer().resolve<PacksModuleService>(PACKS_MODULE);

    // A string body goes on the wire byte for byte, so the test controls
    // exactly what is signed — including spacing a re-serialisation would drop.
    const post = (raw: string, headers: Record<string, string>) =>
      unwrapResponse(
        api.post('/hooks/the7pay/deposit', raw, {
          headers: { 'content-type': 'application/json', ...headers },
        }),
      );

    const approvedRaw = (merchantRefNum: string) =>
      // Deliberately not JSON.stringify's spacing: proves the HMAC is checked
      // against the received bytes, not a re-serialised req.body.
      `{ "status": 1, "msg": "Success", "data": { "amount": 50, "transactionRefNum": "tx-${merchantRefNum}", "merchantRefNum": "${merchantRefNum}", "paymentMethod": "EWALLET", "bankName": "TNG", "status": "APPROVED" } }`;

    const seed = async (merchantRefNum: string, gateway = 'the7pay') => {
      const [row] = await packs().createGatewayDeposits([
        {
          merchant_transaction_id: merchantRefNum,
          customer_id: CUSTOMER_ID,
          amount_requested: 50,
          payment_method_code: 'BQR',
          status: 'pending',
          gateway,
        },
      ]);
      return row;
    };

    it('credits once on an HMAC (Method 2) callback over the raw body', async () => {
      const mtid = 'PC-int-7pay-hmac';
      const row = await seed(mtid);
      const raw = approvedRaw(mtid);

      expect((await post(raw, { 'x-signature': sign(raw) })).data).toBe(
        'success',
      );
      expect((await post(raw, { 'x-signature': sign(raw) })).data).toBe(
        'success',
      );

      const credits = (
        await packs().listCreditTransactions(
          { customer_id: CUSTOMER_ID },
          { take: 50 },
        )
      ).filter((r) => r.reference === `tx-${mtid}`);
      expect(credits).toHaveLength(1);
      expect(Number(credits[0].amount)).toBe(50);
      const [after] = await packs().listGatewayDeposits(
        { id: row.id },
        { take: 1 },
      );
      expect(after.status).toBe('settled');
    });

    it('refuses a signature over other bytes, and TGPay-style headers with the wrong keys', async () => {
      const mtid = 'PC-int-7pay-bad';
      const row = await seed(mtid);
      const raw = approvedRaw(mtid);

      const tampered = await post(
        raw.replace('"amount": 50', '"amount": 50 '),
        {
          'x-signature': sign(raw),
        },
      );
      expect(tampered.status).toBe(401);
      const wrongKeys = await post(raw, {
        'x-public-key': 'pk-int',
        'x-secret-key': 'sk-int',
      });
      expect(wrongKeys.status).toBe(401);

      const [after] = await packs().listGatewayDeposits(
        { id: row.id },
        { take: 1 },
      );
      expect(after.status).toBe('pending');
    });

    it('never settles a TGPay row, even when the 7Pay signature is valid', async () => {
      const mtid = 'PC-int-7pay-crossrow';
      const row = await seed(mtid, 'tgpay');
      const raw = approvedRaw(mtid);
      expect((await post(raw, { 'x-signature': sign(raw) })).data).toBe(
        'success',
      );
      const [after] = await packs().listGatewayDeposits(
        { id: row.id },
        { take: 1 },
      );
      expect(after.status).toBe('pending');
    });
  },
});

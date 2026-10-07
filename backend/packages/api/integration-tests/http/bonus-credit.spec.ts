import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { ledgerTotals } from '../../src/modules/packs/economy';
import { postStoreCustomer, unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

// Bonus credit (泥码, spec 2026-10-07 §4) against the real ledger: spent first
// on pack opens, never withdrawable, never paying any other debit, restored by
// a reversal, and invisible to VIP / referral turnover and the cash lines of
// the economy report.

const PASSWORD = 'bonus-credit-password-1';

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    const packs = () =>
      getContainer().resolve<PacksModuleService>(PACKS_MODULE);

    const grant = (customerId: string, amount: number) =>
      packs().mutateCreditAtomic({
        customerId,
        amount,
        reason: 'bonus_grant',
        bonusCents: Math.round(amount * 100),
      });

    // A deposit with no external basis (pre-1b shape): grandfathered out of the
    // playthrough gate, so withdrawable is decided by the bonus rule alone.
    const plainDeposit = (customerId: string, amount: number) =>
      packs().createCreditTransactions([
        {
          customer_id: customerId,
          amount,
          reason: 'topup' as const,
          external_funded_cents: null,
        },
      ]);

    const open = (customerId: string, amount: number, openId: string) =>
      packs().settleOpen({
        customerId,
        amount: -amount,
        sourceTransactionId: openId,
      });

    describe('bonus credit in the ledger', () => {
      it('is spent first on an open and never counted as withdrawable', async () => {
        const cid = 'cus_bonus_first';
        await plainDeposit(cid, 500);
        await grant(cid, 270);

        let wallet = await packs().walletSummary(cid);
        expect(wallet).toMatchObject({
          balance: 770,
          bonus: 270,
          withdrawable: 500,
        });

        const settled = await open(cid, 300, 'open-bonus-first');
        expect(settled.bonusCents).toBe(27000);
        const [row] = await packs().listCreditTransactions({
          source_transaction_id: 'open-bonus-first',
          reason: 'pack_open',
        });
        expect(Number(row.amount)).toBe(-300);
        expect(row.bonus_cents).toBe(-27000);

        wallet = await packs().walletSummary(cid);
        expect(wallet).toMatchObject({
          balance: 470,
          bonus: 0,
          withdrawable: 470,
        });
      });

      it('banks no playthrough while bonus pays for the open', async () => {
        const cid = 'cus_bonus_playthrough';
        await packs().mutateCreditAtomic({
          customerId: cid,
          amount: 100,
          reason: 'topup',
        });
        await grant(cid, 300);

        await open(cid, 300, 'open-pt-1');
        let wallet = await packs().walletSummary(cid);
        expect(wallet.playthrough.remaining).toBe(100);
        expect(wallet.withdrawable).toBe(0);

        await open(cid, 100, 'open-pt-2');
        wallet = await packs().walletSummary(cid);
        expect(wallet.playthrough.remaining).toBe(0);
        expect(wallet).toMatchObject({ balance: 0, bonus: 0, withdrawable: 0 });
      });

      it('floors every other debit on the normal balance', async () => {
        const cid = 'cus_bonus_floor';
        await plainDeposit(cid, 100);
        await grant(cid, 300);

        await expect(
          packs().mutateCreditAtomic({
            customerId: cid,
            amount: -150,
            reason: 'delivery_fee',
          }),
        ).rejects.toThrow(/Bonus credit can only be spent on packs/);

        await packs().mutateCreditAtomic({
          customerId: cid,
          amount: -100,
          reason: 'delivery_fee',
        });

        // Normal is now 0: an admin deduction cannot touch the bonus either.
        await expect(
          packs().mutateCreditAtomic({
            customerId: cid,
            amount: -50,
            reason: 'adjustment',
          }),
        ).rejects.toThrow(/Bonus credit can only be spent on packs/);
        // More than the whole balance keeps the plain overdraft refusal.
        await expect(
          packs().mutateCreditAtomic({
            customerId: cid,
            amount: -1000,
            reason: 'adjustment',
          }),
        ).rejects.toThrow(/Deduction exceeds the customer's balance/);

        const wallet = await packs().walletSummary(cid);
        expect(wallet).toMatchObject({
          balance: 300,
          bonus: 300,
          withdrawable: 0,
        });
      });

      it('refuses a take-back below the bonus held, and a malformed grant', async () => {
        const cid = 'cus_bonus_takeback';
        await plainDeposit(cid, 1000);
        await grant(cid, 100);

        await expect(grant(cid, -150)).rejects.toThrow(
          /Bonus credit cannot go below RM 0/,
        );
        await grant(cid, -100);
        expect((await packs().walletSummary(cid)).bonus).toBe(0);

        await expect(
          packs().mutateCreditAtomic({
            customerId: cid,
            amount: 50,
            reason: 'bonus_grant',
            bonusCents: 1,
          }),
        ).rejects.toThrow(/bonusCents equal to its amount/);
        await expect(
          packs().mutateCreditAtomic({
            customerId: cid,
            amount: 50,
            reason: 'adjustment',
            bonusCents: 5000,
          }),
        ).rejects.toThrow(/Only a bonus_grant row may carry bonusCents/);
      });

      it('hands the bonus back when an open is reversed', async () => {
        const cid = 'cus_bonus_reverse';
        await grant(cid, 300);
        await open(cid, 300, 'open-reversed');
        expect((await packs().walletSummary(cid)).bonus).toBe(0);

        await packs().reverseOpen('open-reversed');
        const wallet = await packs().walletSummary(cid);
        expect(wallet).toMatchObject({ balance: 300, bonus: 300 });
      });

      it('keeps bonus-funded play out of VIP and referral turnover', async () => {
        const cid = 'cus_bonus_turnover';
        await plainDeposit(cid, 100);
        await grant(cid, 300);
        await open(cid, 300, 'open-turnover-bonus');
        await open(cid, 100, 'open-turnover-normal');

        const summary = await packs().creditSummary(cid);
        expect(summary.vipSpendTotal).toBe(100);
        expect(summary.bonusBalance).toBe(0);
        expect(await packs().lifetimeTurnoverSenFor(cid)).toBe(10000);

        const referral = await (
          packs() as unknown as {
            packTurnoverCentsByCustomer: (i: {
              startUtc: Date;
              endUtcExcl: Date;
              customerIds?: string[];
            }) => Promise<Map<string, number>>;
          }
        ).packTurnoverCentsByCustomer({
          startUtc: new Date(0),
          endUtcExcl: new Date(Date.now() + 60_000),
          customerIds: [cid],
        });
        expect(referral.get(cid)).toBe(10000);
      });

      it('reports only the normal part as revenue, and grants as bonus promo', async () => {
        const cid = 'cus_bonus_economy';
        await plainDeposit(cid, 100);
        await grant(cid, 300);
        await open(cid, 300, 'open-economy-bonus');
        await open(cid, 100, 'open-economy-normal');

        const totals = ledgerTotals(await packs().ledgerReasonTotals());
        expect(totals.revenue).toBe(100);
        expect(totals.bonusPromo).toBe(300);
        expect(totals.topups).toBe(100);
      });
    });

    describe('GET /store/credits', () => {
      it('shows the bonus apart from the withdrawable balance', async () => {
        const container = getContainer();
        const key = await container.resolve(Modules.API_KEY).createApiKeys({
          title: 'bonus-credit-test',
          type: 'publishable',
          created_by: 'bonus-credit-test',
        });
        const storeHeaders = { 'x-publishable-api-key': key.token };
        const email = 'bonus-wallet@test.dev';
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
        const [customer] = await container
          .resolve(Modules.CUSTOMER)
          .listCustomers({ email });

        await plainDeposit(customer.id, 40);
        await grant(customer.id, 50);

        const res = await unwrapResponse(
          api.get('/store/credits', {
            headers: {
              ...storeHeaders,
              authorization: `Bearer ${login.data.token}`,
            },
          }),
        );
        expect(res.status).toBe(200);
        expect(res.data.balance).toBe(90);
        expect(res.data.wallet).toMatchObject({
          balance: 90,
          bonus: 50,
          withdrawable: 40,
        });
        const grantRow = res.data.transactions.find(
          (t: { reason: string }) => t.reason === 'bonus_grant',
        );
        expect(grantRow).toMatchObject({
          amount: 50,
          bonus: 50,
          reference: null,
        });
        const depositRow = res.data.transactions.find(
          (t: { reason: string }) => t.reason === 'topup',
        );
        expect(depositRow.bonus).toBe(0);
      });
    });
  },
});

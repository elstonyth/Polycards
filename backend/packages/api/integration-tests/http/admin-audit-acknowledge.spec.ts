import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { fakeGateway } from '../../src/modules/packs/fake-gateway';
import { setActiveGateway } from '../../src/modules/packs/gateway';
import { mintSuperAdmin, unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

// Settlement's Acknowledge (2026-10-15): POST /admin/payments/audit/acknowledge
// marks a gateway audit finding as dealt with, with a reason. It then leaves
// the "payments differ" count, is listed after the open findings, and its
// reason lands in the admin action log. An acknowledgement covers the note it
// was given for and nothing after it.

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('acknowledging an audit finding', () => {
      const env = { ...process.env };
      let adminToken: string;
      const ADMIN_EMAIL = 'ack-admin@test.dev';

      beforeEach(async () => {
        fakeGateway.reset();
        setActiveGateway(null);
        process.env.GATEWAY_ENABLED = 'true';
        process.env.PAYMENT_GATEWAY = 'fake';
        adminToken = await mintSuperAdmin(
          getContainer(),
          api,
          ADMIN_EMAIL,
          'ack-test-password-1',
        );
      });
      afterAll(() => {
        process.env = env;
        setActiveGateway(null);
      });

      const auth = () => ({
        headers: { authorization: `Bearer ${adminToken}` },
      });
      const audit = async () => {
        const res = await unwrapResponse(
          api.get('/admin/payments/audit?currency=MYR', auth()),
        );
        expect(res.status).toBe(200);
        return res.data;
      };
      const acknowledge = (body: Record<string, unknown>, withAuth = true) =>
        unwrapResponse(
          api.post(
            '/admin/payments/audit/acknowledge',
            body,
            withAuth ? auth() : {},
          ),
        );

      const PAYOUT_NOTE =
        'gateway still reports pending for a payout we refunded';
      const DEPOSIT_NOTE = 'gateway paid 50.06, row credited 50.00';

      const seed = async () => {
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        const [payout] = (await packs.createGatewayWithdrawals([
          {
            merchant_transaction_id: 'PC-ack-payout',
            customer_id: 'cus_ack',
            amount: 512.4,
            bank_code: 'MBB',
            account_number: '000000000000',
            account_holder_name: 'Ack Test',
            status: 'failed',
            gateway: 'fake',
            audit_note: PAYOUT_NOTE,
            audited_at: new Date(),
          },
        ] as never)) as unknown as { id: string }[];
        const [deposit] = (await packs.createGatewayDeposits([
          {
            merchant_transaction_id: 'PC-ack-deposit',
            customer_id: 'cus_ack',
            amount_requested: 50,
            amount_settled: 50,
            payment_method_code: 'BQR',
            status: 'settled',
            settled_at: new Date(),
            gateway: 'fake',
            audit_note: DEPOSIT_NOTE,
            audited_at: new Date(Date.now() - 60_000),
          },
        ] as never)) as unknown as { id: string }[];
        return { packs, payout, deposit };
      };

      it('refuses without an admin, a reason, a known finding or the current note', async () => {
        const { payout } = await seed();
        const ok = { kind: 'withdrawal', id: payout.id, note: PAYOUT_NOTE };
        expect(
          (await acknowledge({ ...ok, reason: 'checked' }, false)).status,
        ).toBe(401);
        expect((await acknowledge({ ...ok, reason: '  ' })).status).toBe(400);
        expect(
          (await acknowledge({ ...ok, kind: 'refund', reason: 'checked' }))
            .status,
        ).toBe(400);
        expect(
          (await acknowledge({ ...ok, id: 'gpw_nope', reason: 'checked' }))
            .status,
        ).toBe(404);
        // The note moved on since the page loaded: never acknowledge blind.
        const stale = await acknowledge({
          ...ok,
          note: 'an older note',
          reason: 'checked',
        });
        expect(stale.status).toBe(409);
        expect((await audit()).acknowledged_total).toBe(0);
      });

      it('takes the finding out of the count, lists it last, and logs the reason', async () => {
        const { packs, payout, deposit } = await seed();
        const before = await audit();
        expect(before.findings_total).toBe(2);
        expect(before.acknowledged_total).toBe(0);
        // A refunded payout normally leads the list.
        expect(before.findings.map((f: { id: string }) => f.id)).toEqual([
          payout.id,
          deposit.id,
        ]);
        expect(before.findings[0].acknowledged).toBeNull();

        const res = await acknowledge({
          kind: 'withdrawal',
          id: payout.id,
          note: PAYOUT_NOTE,
          reason: '  TGPay confirmed it will never pay this out  ',
        });
        expect(res.status).toBe(200);

        const after = await audit();
        expect(after.findings_total).toBe(1);
        expect(after.acknowledged_total).toBe(1);
        expect(after.findings.map((f: { id: string }) => f.id)).toEqual([
          deposit.id,
          payout.id,
        ]);
        expect(after.findings[1].acknowledged).toEqual({
          by: ADMIN_EMAIL,
          at: expect.any(String),
          reason: 'TGPay confirmed it will never pay this out',
        });

        const [row] = await packs.listAdminActionAudits({
          entity_id: payout.id,
        });
        expect(row).toMatchObject({
          entity_type: 'gateway_withdrawal',
          action: 'acknowledge_finding',
          reason: 'TGPay confirmed it will never pay this out',
          after: { note: PAYOUT_NOTE },
        });

        // A deposit finding acknowledges the same way.
        expect(
          (
            await acknowledge({
              kind: 'deposit',
              id: deposit.id,
              note: DEPOSIT_NOTE,
              reason: 'fee rounding, not money',
            })
          ).status,
        ).toBe(200);
        expect((await audit()).findings_total).toBe(0);
      });

      // A retry after a lost response, or a second operator a moment later:
      // answered as done, without a second log row or a new who/when.
      it('acknowledging twice keeps the first acknowledgement', async () => {
        const { packs, payout } = await seed();
        const body = {
          kind: 'withdrawal',
          id: payout.id,
          note: PAYOUT_NOTE,
          reason: 'first',
        };
        expect((await acknowledge(body)).status).toBe(200);
        const first = (await audit()).findings.find(
          (x: { id: string }) => x.id === payout.id,
        ).acknowledged;
        expect(
          (await acknowledge({ ...body, reason: 'second' })).status,
        ).toBe(200);
        const again = (await audit()).findings.find(
          (x: { id: string }) => x.id === payout.id,
        ).acknowledged;
        expect(again).toEqual(first);
        expect(
          await packs.listAdminActionAudits({ entity_id: payout.id }),
        ).toHaveLength(1);
      });

      it('a different note brings the finding back', async () => {
        const { packs, payout } = await seed();
        await acknowledge({
          kind: 'withdrawal',
          id: payout.id,
          note: PAYOUT_NOTE,
          reason: 'TGPay confirmed it will never pay this out',
        });
        await packs.updateGatewayWithdrawals({
          id: payout.id,
          audit_note:
            'DOUBLE PAYMENT: gateway paid out 512.40 for a payout we refunded',
        } as never);
        const after = await audit();
        expect(after.findings_total).toBe(2);
        expect(after.acknowledged_total).toBe(0);
        const f = after.findings.find(
          (x: { id: string }) => x.id === payout.id,
        );
        expect(f.acknowledged).toBeNull();
      });
    });
  },
});

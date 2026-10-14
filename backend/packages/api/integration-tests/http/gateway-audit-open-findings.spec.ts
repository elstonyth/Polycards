import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { fakeGateway } from '../../src/modules/packs/fake-gateway';
import { setActiveGateway } from '../../src/modules/packs/gateway';
import gatewayAuditJob from '../../src/jobs/gateway-audit';

jest.setTimeout(240 * 1000);

// The audit job's open-findings re-check against a real database: the
// `$ne` / `$nin` filters it adds have to mean what they say in SQL.
//   open      a failed payout with a finding, last audited 2 h ago, created
//             9 days ago (outside the 7-day window): re-checked; the gateway
//             now agrees, so its finding clears
//   recent    the same, audited 10 minutes ago: left for a later run
//   retired   a globepay row with a finding: never re-checked

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ getContainer }) => {
    describe('gateway audit: open findings', () => {
      const env = { ...process.env };
      beforeEach(() => {
        fakeGateway.reset();
        setActiveGateway(null);
        process.env.GATEWAY_ENABLED = 'true';
        process.env.PAYMENT_GATEWAY = 'fake';
      });
      afterAll(() => {
        process.env = env;
        setActiveGateway(null);
      });

      it('re-checks an open finding within the hour, at any age, never a retired gateway', async () => {
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);
        const note = 'gateway still reports pending for a payout we refunded';
        const base = {
          customer_id: 'cus_audit_open',
          amount: 512.4,
          bank_code: 'MBB',
          account_number: '000000000000',
          account_holder_name: 'Audit Test',
          status: 'failed' as const,
          audit_note: note,
        };
        const [open, recent, retired] = await packs.createGatewayWithdrawals([
          {
            ...base,
            merchant_transaction_id: 'PC-audit-open',
            gateway: 'fake',
            audited_at: hoursAgo(2),
          },
          {
            ...base,
            merchant_transaction_id: 'PC-audit-recent',
            gateway: 'fake',
            audited_at: hoursAgo(10 / 60),
          },
          {
            ...base,
            merchant_transaction_id: 'PC-audit-retired',
            gateway: 'globepay',
            audit_note:
              'gateway "globepay" is not configured here — not audited',
            audited_at: hoursAgo(2),
          },
        ] as never);
        // Old enough to be outside the 7-day window the daily checks use.
        await packs.updateGatewayWithdrawals([
          { id: open.id, created_at: hoursAgo(9 * 24) },
        ] as never);
        fakeGateway.script({
          getWithdrawalDetail: { state: 'failed', amount: 512.4 },
        });

        await gatewayAuditJob(getContainer() as never);

        expect(fakeGateway.calls.withdrawalDetails).toEqual(['PC-audit-open']);
        const [after] = await packs.listGatewayWithdrawals({ id: open.id });
        expect(after.audit_note).toBeNull();
        expect(new Date(after.audited_at as Date).getTime()).toBeGreaterThan(
          hoursAgo(0.1).getTime(),
        );
        const [untouched] = await packs.listGatewayWithdrawals({
          id: recent.id,
        });
        expect(untouched.audit_note).toBe(note);
        const [old] = await packs.listGatewayWithdrawals({ id: retired.id });
        expect(new Date(old.audited_at as Date).getTime()).toBeLessThan(
          hoursAgo(1).getTime(),
        );
      });
    });
  },
});

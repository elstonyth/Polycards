import path from 'path';
import { moduleIntegrationTestRunner } from '@medusajs/test-utils';
import { PACKS_MODULE } from '../index';
import type PacksModuleService from '../service';
import ReferralAttribution from '../models/referral-attribution';
import ReferralSettings from '../models/referral-settings';
import CustomerAccountState from '../models/customer-account-state';
import AdminActionAudit from '../models/admin-action-audit';
import CreditTransaction from '../models/credit-transaction';
import { DEFAULT_REFERRAL_TIERS } from '../referral';

jest.setTimeout(300 * 1000);

moduleIntegrationTestRunner<PacksModuleService>({
  moduleName: PACKS_MODULE,
  resolve: path.resolve(__dirname, '../../..', 'modules/packs'),
  moduleModels: [
    ReferralAttribution,
    ReferralSettings,
    CustomerAccountState,
    AdminActionAudit,
    // bindReferral reads pack_open turnover to enforce "signup only".
    CreditTransaction,
  ],
  testSuite: ({ service }) => {
    describe('bindReferral', () => {
      it('binds once, permanently', async () => {
        const first = await service.bindReferral({
          customerId: 'cus_a',
          referrerId: 'cus_r',
          createdAt: new Date(),
        });
        expect(first).toEqual({ bound: true });

        // A second bind — even to a DIFFERENT referrer — is refused and the
        // original row is untouched.
        const second = await service.bindReferral({
          customerId: 'cus_a',
          referrerId: 'cus_other',
          createdAt: new Date(),
        });
        expect(second).toEqual({ bound: false, reason: 'already_bound' });

        const rows = await service.listReferralAttributions({
          customer_id: 'cus_a',
        });
        expect(rows).toHaveLength(1);
        expect(rows[0].referrer_id).toBe('cus_r');
      });

      it('rejects self-referral', async () => {
        const r = await service.bindReferral({
          customerId: 'cus_self',
          referrerId: 'cus_self',
          createdAt: new Date(),
        });
        expect(r).toEqual({ bound: false, reason: 'self' });
        expect(
          await service.listReferralAttributions({ customer_id: 'cus_self' }),
        ).toHaveLength(0);
      });
    });

    describe('referral settings', () => {
      it('lazy-seeds the defaults on first read', async () => {
        const s = await service.getReferralSettings();
        expect(s.tiers).toEqual(DEFAULT_REFERRAL_TIERS);
        expect(s.partner_min_bp).toBe(300);
        expect(s.partner_max_bp).toBe(500);
      });

      it('edit persists and audits', async () => {
        const tiers = [
          { min_cents: 0, rate_bp: 60 },
          { min_cents: 1_000_000, rate_bp: 120 },
        ];
        await service.editReferralSettings({
          tiers,
          partner_min_bp: 250,
          partner_max_bp: 600,
          adminId: 'admin_1',
          reason: 'test edit',
        });
        const s = await service.getReferralSettings();
        expect(s.tiers).toEqual(tiers);
        expect(s.partner_min_bp).toBe(250);
        expect(s.partner_max_bp).toBe(600);
        const audits = await service.listAdminActionAudits({
          action: 'edit_referral_settings',
        });
        expect(audits.length).toBeGreaterThanOrEqual(1);
      });

      it('rejects a tier table whose first row is not 0', async () => {
        await expect(
          service.editReferralSettings({
            tiers: [{ min_cents: 100, rate_bp: 50 }],
            adminId: 'admin_1',
            reason: 'bad',
          }),
        ).rejects.toThrow(/first tier/i);
      });

      it('rejects duplicate tier bounds and out-of-range rates', async () => {
        await expect(
          service.editReferralSettings({
            tiers: [
              { min_cents: 0, rate_bp: 50 },
              { min_cents: 0, rate_bp: 100 },
            ],
            adminId: 'admin_1',
            reason: 'bad',
          }),
        ).rejects.toThrow(/strictly increasing/i);
        await expect(
          service.editReferralSettings({
            tiers: [{ min_cents: 0, rate_bp: 10_001 }],
            adminId: 'admin_1',
            reason: 'bad',
          }),
        ).rejects.toThrow(/rate_bp/i);
      });

      it('rejects partner bounds where min >= max', async () => {
        await expect(
          service.editReferralSettings({
            partner_min_bp: 500,
            partner_max_bp: 500,
            adminId: 'admin_1',
            reason: 'bad',
          }),
        ).rejects.toThrow(/partner/i);
      });
    });

    describe('setPartnerRate', () => {
      it('accepts an in-bounds rate, lazy-creating the account-state row', async () => {
        await service.setPartnerRate({
          customerId: 'cus_p1',
          rateBp: 400,
          adminId: 'admin_1',
        });
        const [state] = await service.listCustomerAccountStates({
          customer_id: 'cus_p1',
        });
        expect(state.partner_referral_bp).toBe(400);
        const audits = await service.listAdminActionAudits({
          action: 'set_partner_rate',
          entity_id: 'cus_p1',
        });
        expect(audits).toHaveLength(1);
      });

      it('null clears the partner flag', async () => {
        await service.setPartnerRate({
          customerId: 'cus_p1',
          rateBp: null,
          adminId: 'admin_1',
        });
        const [state] = await service.listCustomerAccountStates({
          customer_id: 'cus_p1',
        });
        expect(state.partner_referral_bp).toBeNull();
      });

      it('rejects an out-of-bounds rate', async () => {
        await expect(
          service.setPartnerRate({
            customerId: 'cus_p2',
            rateBp: 10,
            adminId: 'admin_1',
          }),
        ).rejects.toThrow(/bounds|between/i);
      });
    });
  },
});

/**
 * Real name + phone lock — service seam (integration:modules)
 *
 * Spec docs/superpowers/specs/2026-10-06-real-name-and-phone-lock-design.md.
 * Asserted contracts:
 *  - setRealName: the customer's write lands ONCE; a second (or concurrent)
 *    write is refused and never overwrites.
 *  - setRealName: a name another account holds is refused (ADR 0015).
 *  - getVerificationState: the two facts the welcome-pack gate reads.
 *  - adminSetRealName: overwrites, audited with before/after/reason.
 *  - recordAdminPhoneChange: audits the move (the route writes + stamps).
 *
 * Test-runner caveat: moduleIntegrationTestRunner rebuilds schema from MODELS,
 * not from the hand-written migrations — CHECK constraints are absent, so the
 * audit-action CHECK is pinned by admin-audit-config-enums.unit.spec.ts.
 */

import path from 'path';
import { moduleIntegrationTestRunner } from '@medusajs/test-utils';
import { PACKS_MODULE } from '../index';
import type PacksModuleService from '../service';
import CustomerAccountState from '../models/customer-account-state';
import AdminActionAudit from '../models/admin-action-audit';
import { REAL_NAME_TAKEN } from '../../../utils/real-name';

jest.setTimeout(300 * 1000);

moduleIntegrationTestRunner<PacksModuleService>({
  moduleName: PACKS_MODULE,
  resolve: path.resolve(__dirname, '../../..', 'modules/packs'),
  moduleModels: [CustomerAccountState, AdminActionAudit],
  testSuite: ({ service }) => {
    const stateOf = async (customerId: string) => {
      const rows = await service.listCustomerAccountStates({
        customer_id: customerId,
      });
      expect(rows.length).toBeLessThanOrEqual(1); // one row per customer
      return rows[0];
    };

    describe('setRealName (customer, one-time)', () => {
      it('sets the name once and refuses a second write without overwriting', async () => {
        expect(await service.setRealName('cus_rn_1', 'Tan Ah Kow')).toBe(true);
        const first = (await stateOf('cus_rn_1'))!;
        expect(first.real_name).toBe('Tan Ah Kow');
        expect(first.real_name_set_at).toBeTruthy();

        expect(await service.setRealName('cus_rn_1', 'Someone Else')).toBe(
          false,
        );
        const after = (await stateOf('cus_rn_1'))!;
        expect(after.real_name).toBe('Tan Ah Kow');
        expect(new Date(after.real_name_set_at!).getTime()).toBe(
          new Date(first.real_name_set_at!).getTime(),
        );
      });

      it('writes onto an existing state row instead of creating a second one', async () => {
        await service.markFreePackAvailable('cus_rn_2');
        expect(await service.setRealName('cus_rn_2', 'Lee Mei Ling')).toBe(
          true,
        );
        const state = (await stateOf('cus_rn_2'))!;
        expect(state.real_name).toBe('Lee Mei Ling');
        expect(state.free_pack_available_at).toBeTruthy();
      });

      // A double-tapped confirm: exactly one write wins, and the stored name
      // is the winner's — never a later overwrite.
      it('lets exactly one of two concurrent writes win', async () => {
        const results = await Promise.all([
          service.setRealName('cus_rn_3', 'First Name A'),
          service.setRealName('cus_rn_3', 'Second Name B'),
        ]);
        expect(results.filter(Boolean)).toHaveLength(1);
        const winner = results[0] ? 'First Name A' : 'Second Name B';
        expect((await stateOf('cus_rn_3'))!.real_name).toBe(winner);
      });
    });

    // One person, one account (ADR 0015). Names already on file stay as they
    // are; this only refuses a new save.
    describe('setRealName (a name another account holds)', () => {
      const nameOf = async (customerId: string) =>
        (await stateOf(customerId))?.real_name ?? null;

      it('refuses it ignoring case, spacing and separators, and writes nothing', async () => {
        await service.setRealName('cus_dup_1', 'Tan Ah-Kow');

        for (const same of [
          'Tan Ah-Kow',
          'TAN AH KOW',
          'tan ahkow',
          "Tan Ah K'ow",
          'Tan.Ah/Kow',
        ]) {
          await expect(service.setRealName('cus_dup_2', same)).rejects.toThrow(
            REAL_NAME_TAKEN,
          );
        }
        expect(await nameOf('cus_dup_2')).toBeNull();

        expect(await service.setRealName('cus_dup_2', 'Tan Ah Kau')).toBe(true);
        expect(await nameOf('cus_dup_2')).toBe('Tan Ah Kau');
      });

      // Comparing on Latin letters alone would make every Chinese name equal.
      it('keeps names in other scripts apart', async () => {
        expect(await service.setRealName('cus_dup_3', '陈大文')).toBe(true);
        expect(await service.setRealName('cus_dup_4', '陈小文')).toBe(true);
        await expect(service.setRealName('cus_dup_5', '陈大文')).rejects.toThrow(
          REAL_NAME_TAKEN,
        );
      });

      // Postgres lower() follows the database locale, and a C locale would miss this.
      it('folds case beyond ASCII', async () => {
        expect(await service.setRealName('cus_dup_13', 'ÉRIC TAN')).toBe(true);
        await expect(
          service.setRealName('cus_dup_14', 'éric tan'),
        ).rejects.toThrow(REAL_NAME_TAKEN);
      });

      it('lets exactly one of two accounts racing for a name win', async () => {
        const results = await Promise.allSettled([
          service.setRealName('cus_dup_6', 'Lim Siew Hua'),
          service.setRealName('cus_dup_7', 'LIM SIEW HUA'),
        ]);
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        const refused = results.find((r) => r.status === 'rejected');
        expect((refused as PromiseRejectedResult).reason.message).toBe(
          REAL_NAME_TAKEN,
        );
      });

      it('tells the holder their own name is on file, not taken', async () => {
        await service.setRealName('cus_dup_8', 'Wong Kar Wai');
        expect(await service.setRealName('cus_dup_8', 'WONG KAR WAI')).toBe(
          false,
        );
      });

      // Account deletion keeps the row as a tombstone and blanks the name.
      it('frees the name once its holder is gone', async () => {
        await service.setRealName('cus_dup_9', 'Ong Bee Lian');
        const held = (await stateOf('cus_dup_9'))!;
        await service.updateCustomerAccountStates({
          selector: { id: held.id },
          data: { disabled: true, real_name: null, real_name_set_at: null },
        });
        expect(await service.setRealName('cus_dup_10', 'Ong Bee Lian')).toBe(
          true,
        );
      });

      // The way out for two real people with one name.
      it('leaves support able to set a name another account holds', async () => {
        await service.setRealName('cus_dup_11', 'Siti Aminah');
        await service.adminSetRealName({
          customerId: 'cus_dup_12',
          adminId: 'user_cs',
          realName: 'Siti Aminah',
          reason: 'different person, IC checked',
        });
        expect(await nameOf('cus_dup_12')).toBe('Siti Aminah');
      });
    });

    describe('getVerificationState', () => {
      it('reports nothing for an account with no state row', async () => {
        expect(await service.getVerificationState('cus_none')).toEqual({
          phoneVerified: false,
          realName: null,
        });
      });

      it('reports the phone stamp and the name independently', async () => {
        await service.markPhoneVerified('cus_vs');
        expect(await service.getVerificationState('cus_vs')).toEqual({
          phoneVerified: true,
          realName: null,
        });
        await service.setRealName('cus_vs', 'Tan Ah Kow');
        expect(await service.getVerificationState('cus_vs')).toEqual({
          phoneVerified: true,
          realName: 'Tan Ah Kow',
        });
      });
    });

    describe('customer-service corrections', () => {
      it('adminSetRealName overwrites a set name and audits before/after', async () => {
        await service.setRealName('cus_cs_1', 'Tan Ah Kow');
        await service.adminSetRealName({
          customerId: 'cus_cs_1',
          adminId: 'user_cs',
          realName: 'Tan Ah Kau',
          reason: 'typo, checked against TNG',
        });

        expect((await stateOf('cus_cs_1'))!.real_name).toBe('Tan Ah Kau');
        const [audit] = await service.listAdminActionAudits({
          entity_id: 'cus_cs_1',
          action: 'set_real_name',
        });
        expect(audit).toMatchObject({
          admin_id: 'user_cs',
          entity_type: 'customer',
          before: { real_name: 'Tan Ah Kow' },
          after: { real_name: 'Tan Ah Kau' },
          reason: 'typo, checked against TNG',
        });
      });

      it('adminSetRealName creates the row for an account that never had one', async () => {
        await service.adminSetRealName({
          customerId: 'cus_cs_2',
          adminId: 'user_cs',
          realName: 'Lee Mei Ling',
          reason: 'set by phone call',
        });
        expect((await stateOf('cus_cs_2'))!.real_name).toBe('Lee Mei Ling');
        // A customer write afterwards is still refused — the name is on file.
        expect(await service.setRealName('cus_cs_2', 'Other Name')).toBe(false);
      });

      it('recordAdminPhoneChange audits the move', async () => {
        await service.recordAdminPhoneChange({
          customerId: 'cus_cs_3',
          adminId: 'user_cs',
          before: '+60111111111',
          after: '+60122222222',
          reason: 'lost SIM, identity checked',
        });

        const [audit] = await service.listAdminActionAudits({
          entity_id: 'cus_cs_3',
          action: 'set_phone',
        });
        expect(audit).toMatchObject({
          admin_id: 'user_cs',
          entity_type: 'customer',
          before: { phone: '+60111111111' },
          after: { phone: '+60122222222' },
          reason: 'lost SIM, identity checked',
        });
      });
    });
  },
});

import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { VIP_LEVELS } from '../../src/scripts/vip-levels.data';

jest.setTimeout(180 * 1000);

// Regression: an unseeded vip_level ladder must NOT abort a recruit's paid open.
//
// Before hardening, settleOpen's commission fan-out called
// levelForSpend(sponsorLifetimeMyr, levelLadder) with an EMPTY ladder, which
// throws "levelForSpend: ladder is empty" INSIDE the atomic charge txn — so any
// recruit who has a sponsor could not open a pack at all if vip_level was never
// seeded (migrations-without-seed; the same root cause that strands VIP at L1).
//
// Desired (hardened) behaviour, asserted here: the open completes (debit
// applied), the commission fan-out is skipped, and no commission rows are
// written. The deliberate "throw on a MISSING SPECIFIC level row" invariant for
// a partially-seeded ladder is unchanged — this only covers the empty-ladder
// (system-unconfigured) case.
medusaIntegrationTestRunner({
  inApp: true,
  env: { COMMISSION_COOLDOWN_DAYS: '0' },
  testSuite: ({ getContainer }) => {
    describe('settleOpen with an unseeded vip_level ladder', () => {
      // NOTE: both cases below deliberately leave vip_level non-canonical
      // (empty / gapped) and deliberately do NOT restore it. Restoring would be
      // dead code: the runner truncates every table in its own afterEach AND
      // again in its beforeEach, so nothing here can survive to a later test —
      // any test added to this suite must seed the ladder state it needs.
      it('charges the recruit and skips commission instead of throwing', async () => {
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);

        // Deliberately DO NOT seed the ladder: clear whatever is present so the
        // empty-ladder branch is what we actually exercise.
        const existing = await packs.listVipLevels({}, { take: 1000 });
        if (existing.length > 0) {
          await packs.deleteVipLevels(existing.map((r) => r.id));
        }

        const sponsor = 'cus_noladder_sponsor';
        const recruit = 'cus_noladder_recruit';
        await packs.linkSponsor({ recruitId: recruit, sponsorId: sponsor });
        await packs.mutateCreditAtomic({
          customerId: recruit,
          amount: 100,
          reason: 'topup',
          reference: 'mock_noladder',
        });

        // The paid open must survive a missing ladder (no throw), pay no
        // commission, and still debit the recruit.
        const r = await packs.settleOpen({
          customerId: recruit,
          amount: -100,
          sourceTransactionId: 'open_noladder_1',
        });
        expect(r.commissions).toEqual([]);

        expect(await packs.creditBalance(recruit)).toBe(0); // RM100 spent
        expect(await packs.creditBalance(sponsor)).toBe(0); // no commission
        const comms = await packs.listCommissions(
          { source_transaction_id: 'open_noladder_1' },
          { take: 10 },
        );
        expect(comms).toHaveLength(0);
      });

      // The guard is scoped to a TRULY-empty ladder. A partially-seeded ladder
      // must behave exactly as before: levelForSpend only ever returns a rung
      // present in the rowset, so directReferralPctForLevel resolves it and
      // commission is paid normally (no throw, no skip).
      it('pays commission normally on a partially-seeded (gapped) ladder', async () => {
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);

        const existing = await packs.listVipLevels({}, { take: 1000 });
        if (existing.length > 0) {
          await packs.deleteVipLevels(existing.map((r) => r.id));
        }
        // Seed a GAPPED ladder: L1 + L5 only (L2-L4 deliberately missing).
        await packs.createVipLevels(
          VIP_LEVELS.filter((r) => r.level === 1 || r.level === 5).map((r) => ({
            ...r,
          })),
        );

        const sponsor = 'cus_partial_sponsor';
        const recruit = 'cus_partial_recruit';
        await packs.linkSponsor({ recruitId: recruit, sponsorId: sponsor });
        await packs.mutateCreditAtomic({
          customerId: recruit,
          amount: 100,
          reason: 'topup',
          reference: 'mock_partial',
        });

        // Sponsor lifetime 0 -> resolves L1 (threshold 0), which IS present ->
        // 1% of 10 000 sen = 100 sen, exactly as on a fully-seeded ladder.
        const r = await packs.settleOpen({
          customerId: recruit,
          amount: -100,
          sourceTransactionId: 'open_partial_1',
        });
        expect(r.commissions).toEqual([
          { beneficiary: sponsor, amountSen: 100, matured: true },
        ]);
        expect(await packs.creditBalance(sponsor)).toBe(1);
      });
    });
  },
});

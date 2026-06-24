import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { VIP_LEVELS } from '../../src/scripts/vip-levels.data';

jest.setTimeout(180 * 1000);

medusaIntegrationTestRunner({
  inApp: true,
  env: { COMMISSION_COOLDOWN_DAYS: '0' }, // demo: immediate maturity
  testSuite: ({ getContainer }) => {
    async function seedLadder(packs: PacksModuleService) {
      const existing = await packs.listVipLevels({}, { take: 1 });
      if (existing.length === 0) {
        await packs.createVipLevels(
          VIP_LEVELS.map((r) => ({
            level: r.level,
            spend_threshold: r.spend_threshold,
            voucher_amount: r.voucher_amount,
            box_tier: r.box_tier,
            frame_unlock: r.frame_unlock,
            direct_referral_pct: r.direct_referral_pct,
            prizes: r.prizes ?? null,
          })),
        );
      }
    }

    describe('referralSummary (privacy-bounded gen-1 + aggregates)', () => {
      it('referralSummary: gen-1 only, contribution is direct-only, downstream counts all gens', async () => {
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        await seedLadder(packs);

        // Chain: me -> R1 -> R2 -> R3, plus a second DIRECT recruit R1b.
        const me = 'cus_rs_me';
        const R1 = 'cus_rs_r1';
        const R1b = 'cus_rs_r1b';
        const R2 = 'cus_rs_r2';
        const R3 = 'cus_rs_r3';

        await packs.linkSponsor({ recruitId: R1, sponsorId: me });
        await packs.linkSponsor({ recruitId: R1b, sponsorId: me });
        await packs.linkSponsor({ recruitId: R2, sponsorId: R1 });
        await packs.linkSponsor({ recruitId: R3, sponsorId: R2 });

        // R1 opens RM100 external-funded. I am R1's DIRECT sponsor (L1 = 1%) ->
        // direct_referral to me = 1% of 10,000 sen = 100 sen = RM1.  (= D1)
        await packs.mutateCreditAtomic({
          customerId: R1,
          amount: 100,
          reason: 'topup',
          reference: 'mock_rs_r1',
        });
        await packs.settleOpen({
          customerId: R1,
          amount: -100,
          sourceTransactionId: 'open_rs_r1',
        });
        const D1 = 1; // RM1 direct commission to me from R1's open

        // R2 opens RM100 external-funded. R2's direct sponsor is R1 (R1 gets the
        // direct). I am R2's gen-2 ancestor -> team_override to me = 20% of R1's
        // 100-sen direct = 20 sen = RM0.20.  (= O)  This must NOT count as R1's
        // "contribution" (it is an override, not a direct_referral).
        await packs.mutateCreditAtomic({
          customerId: R2,
          amount: 100,
          reason: 'topup',
          reference: 'mock_rs_r2',
        });
        await packs.settleOpen({
          customerId: R2,
          amount: -100,
          sourceTransactionId: 'open_rs_r2',
        });
        const O = 0.2; // RM0.20 override to me from R2's open

        const s = await packs.referralSummary(me);

        // Privacy: ONLY direct recruits surface (gen-1), and NO R2/R3 id anywhere.
        expect(s.directRecruits.map((r) => r.customerId).sort()).toEqual(
          [R1, R1b].sort(),
        );
        const json = JSON.stringify(s);
        expect(json).not.toContain(R2);
        expect(json).not.toContain(R3);

        // Contribution = direct commission from THAT recruit's opens only
        // (R2's override into me is excluded).
        expect(
          s.directRecruits.find((r) => r.customerId === R1)!.contribution,
        ).toBeCloseTo(D1, 2);
        // R1b never opened -> zero contribution.
        expect(
          s.directRecruits.find((r) => r.customerId === R1b)!.contribution,
        ).toBeCloseTo(0, 2);

        // downstreamCount = ALL generations under me: R1, R1b, R2, R3 = 4.
        expect(s.downstreamCount).toBe(4);

        // totalEarned = direct + override, net of reversals = D1 + O.
        expect(s.totalEarned).toBeCloseTo(D1 + O, 2);
      });

      it('referralSummary: contribution nets a reversed open (no 2x double-count)', async () => {
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        await seedLadder(packs);

        // me -> R1 (direct). R1 opens RM100 external-funded; I am R1's L1 sponsor
        // (1%) -> direct_referral to me = 1% of 10,000 sen = 100 sen = RM1 (= D1).
        const me = 'cus_rsrev_me';
        const R1 = 'cus_rsrev_r1';
        await packs.linkSponsor({ recruitId: R1, sponsorId: me });

        await packs.mutateCreditAtomic({
          customerId: R1,
          amount: 100,
          reason: 'topup',
          reference: 'mock_rsrev_r1',
        });
        await packs.settleOpen({
          customerId: R1,
          amount: -100,
          sourceTransactionId: 'open_rsrev_r1',
        });
        const D1 = 1; // RM1 direct commission to me from R1's open

        // Before the reversal, R1's contribution is exactly the one direct
        // commission (D1) — a sanity baseline for the post-reversal assertion.
        const before = await packs.referralSummary(me);
        expect(
          before.directRecruits.find((r) => r.customerId === R1)!.contribution,
        ).toBeCloseTo(D1, 2);

        // Admin-reverse R1's open: appends a compensating POSITIVE 'pack_open'
        // refund row (same open_id) + a NEGATIVE 'commission_reversal' clawing
        // back my direct commission (same open_id). reverseOpen is the open-scoped
        // clawback path used by the 2b/3a specs (vip-member-state, level-up-grant).
        const { reversed } = await packs.reverseOpen('open_rsrev_r1');
        expect(reversed).toBeGreaterThan(0);

        // After the reversal, R1's contribution must be CORRECT, not doubled.
        // The de-dup fix (po.amount < 0) stops the refund row from joining twice;
        // the netting fix (mine.reason IN direct_referral,commission_reversal)
        // nets the clawback against the original credit -> contribution ~= 0,
        // consistent with totalEarned which also nets reversals.
        const after = await packs.referralSummary(me);
        expect(
          after.directRecruits.find((r) => r.customerId === R1)!.contribution,
        ).toBeCloseTo(0, 2);
        // totalEarned (independently correct path) nets to 0 too — cross-check.
        expect(after.totalEarned).toBeCloseTo(0, 2);
      });
    });
  },
});

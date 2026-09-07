/**
 * The audit row rides the caller's transaction — integration:modules
 *
 * WHY this exists on top of the http audit specs: those all assert "the row is
 * there after a successful change" or "no row after a refused one". Neither
 * distinguishes an audit written INSIDE the change's transaction from one that
 * opened its own — a helper that ignored `sharedContext` and called
 * `createAdminActionAudits([row], {})` would pass every one of them, while
 * leaving exactly the bug this task removed: a rolled-back change with a
 * committed audit row claiming it happened.
 *
 * This proves `protected audit(row, sharedContext)` forwards the transaction
 * for `createChallengeSchedule`, which needs the fewest models to stand up.
 * Other callers' context forwarding was statically reviewed; this test does
 * not establish their runtime transaction behavior.
 *
 * Method: run the operation against a FORKED manager with an open transaction
 * (the same idiom as withdrawal-claim.integration.spec.ts), roll it back, then
 * read both tables on the normal manager. An escaped audit shows up as
 * "schedule gone, audit present".
 */

import path from 'path';
import { moduleIntegrationTestRunner } from '@medusajs/test-utils';
import type { Context } from '@medusajs/framework/types';
import { PACKS_MODULE } from '../index';
import type PacksModuleService from '../service';
import ChallengeSchedule from '../models/challenge-schedule';
import AdminActionAudit from '../models/admin-action-audit';

jest.setTimeout(300 * 1000);

const STAGES = [
  {
    stage_number: 1,
    threshold_myr: 100,
    rank_rewards: [{ rank: 1, card_id: null, credits: 10 }],
  },
];

moduleIntegrationTestRunner<PacksModuleService>({
  moduleName: PACKS_MODULE,
  resolve: path.resolve(__dirname, '../../..', 'modules/packs'),
  // A modules-type spec builds its schema from THIS array, never from the
  // migrations — both tables the operation writes have to be listed.
  moduleModels: [ChallengeSchedule, AdminActionAudit],
  testSuite: ({ service, MikroOrmWrapper }) => {
    const auditsFor = (entityId: string) =>
      service.listAdminActionAudits(
        { entity_type: 'challenge_stages', entity_id: entityId },
        { take: 5 },
      );

    it('commits the audit row with the change', async () => {
      const startsAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      const { id } = await service.createChallengeSchedule({
        startsAt,
        label: 'committed',
        stages: STAGES,
        adminId: 'admin_atomic_1',
        reason: 'queue an edition',
      });

      // The baseline the rollback case is measured against: on the happy path
      // both rows land, so an absent audit below is genuinely a rollback and
      // not a write that never happened.
      expect(
        await service.listChallengeSchedules({ id }, { take: 1 }),
      ).toHaveLength(1);
      const audits = await auditsFor(id);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        admin_id: 'admin_atomic_1',
        action: 'create',
        reason: 'queue an edition',
      });
    });

    it('rolls the audit row back with the change', async () => {
      const em = MikroOrmWrapper.forkManager();
      await em.begin();
      let id: string;
      try {
        // Joining the caller's transaction is what `@InjectTransactionManager`
        // does when the context already carries a manager: it reuses it rather
        // than opening its own. Both writes therefore land in THIS txn.
        ({ id } = await service.createChallengeSchedule(
          {
            startsAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
            label: 'rolled back',
            stages: STAGES,
            adminId: 'admin_atomic_2',
            reason: 'queue then abandon',
          },
          { transactionManager: em } as unknown as Context,
        ));
      } finally {
        // Simulates any later failure in the same unit of work. Rollback is in
        // `finally` so a failed assertion can never leave the transaction open
        // and wedge the rest of the file.
        await em.rollback();
      }

      // Read on the NORMAL manager — committed state only.
      expect(
        await service.listChallengeSchedules({ id }, { take: 1 }),
      ).toHaveLength(0);
      // The assertion this file exists for. If `audit()` ever stops forwarding
      // `sharedContext` (or is handed a fresh `{}`), this row survives the
      // rollback and permanently records an edition that was never queued.
      expect(await auditsFor(id)).toHaveLength(0);
    });
  },
});

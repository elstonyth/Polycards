/**
 * revealPull first_reveal flag (service.ts) — integration:modules
 *
 * `first_reveal` is the exactly-once trigger for the public Telegram
 * announcement: POST /store/pulls/:id/reveal emits `pull.revealed` only when it
 * is true, and Telegram has no dedupe of its own, so a second `true` for the
 * same pull is a duplicate post of somebody's hit to a public channel.
 *
 * It cannot be unit-tested honestly. The guarantee is the FILTERED update
 * (`selector: { id, revealed_at: null }`) matching zero rows on the second
 * call — that is the database enforcing it, so a mock proves nothing.
 *
 * Asserted contracts:
 *  - First reveal stamps revealed_at and reports first_reveal: true.
 *  - Re-revealing the same pull reports false and does not move the anchor
 *    (the sell deadline must not slide on a re-mounted reveal stage).
 *  - A pull already revealed at open time reports false on its first call.
 *  - A foreign customer still 404s and never stamps.
 *
 * Test-runner caveat: moduleIntegrationTestRunner builds schema from the
 * moduleModels array. Pull has no DB-level FK to Pack/Card (business-key
 * strings only), so only Pull is needed here — same minimal-model precedent as
 * close-instant.integration.spec.ts.
 */

import path from 'path';
import { moduleIntegrationTestRunner } from '@medusajs/test-utils';
import { PACKS_MODULE } from '../index';
import type PacksModuleService from '../service';
import Pull from '../models/pull';

jest.setTimeout(300 * 1000);

moduleIntegrationTestRunner<PacksModuleService>({
  moduleName: PACKS_MODULE,
  resolve: path.resolve(__dirname, '../../..', 'modules/packs'),
  moduleModels: [Pull],
  testSuite: ({ service }) => {
    const ROLLED = new Date('2026-08-01T12:00:00Z');
    const OWNER = 'cus_reveal_owner';

    async function seedPull(revealedAt: Date | null) {
      const [pull] = await service.createPulls([
        {
          customer_id: OWNER,
          pack_id: 'bronze-pack',
          card_id: 'test-charizard',
          order_id: null,
          rolled_at: ROLLED,
          revealed_at: revealedAt,
          instant_closed_at: null,
          source: 'pack',
          recorded_value_usd: 100,
        },
      ]);
      return pull!;
    }

    describe('revealPull', () => {
      it('reports first_reveal on the call that stamps, and never again', async () => {
        const pull = await seedPull(null);
        const firstAt = ROLLED.getTime() + 5_000;

        const first = await service.revealPull(pull.id, OWNER, firstAt);
        expect(first.first_reveal).toBe(true);

        // A re-mounted reveal stage pings again. It must not announce a second
        // time, and it must not slide the sell deadline.
        const second = await service.revealPull(
          pull.id,
          OWNER,
          firstAt + 20_000,
        );
        expect(second.first_reveal).toBe(false);
        expect(second.instant_deadline_ms).toBe(first.instant_deadline_ms);

        const [fresh] = await service.listPulls({ id: pull.id }, { take: 1 });
        expect(fresh.revealed_at?.getTime()).toBe(firstAt);
      });

      it('reports false for a pull that was already revealed', async () => {
        const pull = await seedPull(new Date(ROLLED.getTime() + 1_000));
        const result = await service.revealPull(
          pull.id,
          OWNER,
          ROLLED.getTime() + 9_000,
        );
        expect(result.first_reveal).toBe(false);
      });

      // The announcement names the puller publicly, so a foreign reveal that
      // slipped through would post someone else's pull under the wrong flow.
      it('404s for a different customer and leaves the pull unrevealed', async () => {
        const pull = await seedPull(null);
        await expect(
          service.revealPull(pull.id, 'cus_someone_else'),
        ).rejects.toThrow();
        const [fresh] = await service.listPulls({ id: pull.id }, { take: 1 });
        expect(fresh.revealed_at).toBeNull();
      });
    });
  },
});

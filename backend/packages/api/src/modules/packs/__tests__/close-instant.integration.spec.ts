/**
 * close-instant (POST /store/pulls/close-instant -> closeInstantWindow) —
 * integration:modules
 *
 * The instant-buyback window is closed EARLY when the reveal ends (Spin
 * again / navigate away) so the vault and every later sell quote the flat
 * rate even inside the 30s time deadline. CLOSE-ONLY + owner-scoped +
 * idempotent (service.ts closeInstantWindow, ~line 3783). buyback-rate.unit
 * .spec.ts already pins the RATE math for both instant_closed_at branches of
 * resolveBuybackRate — this spec covers the WRITE path, which had zero test
 * references: a broken owner check would let an authenticated customer close
 * ANOTHER customer's instant window, dropping their sell quote to flat early.
 *
 * Asserted contracts:
 *  - Owner closes own pull -> instant_closed_at stamped, resolveBuybackRate
 *    flips from instant to the flat vault rate.
 *  - Customer B cannot close customer A's pull (ownership filter).
 *  - Re-closing an already-closed pull is a no-op: closed: 0, timestamp
 *    unchanged (never re-opens, never re-stamps).
 *  - An empty id list is a no-op success, not an error.
 *
 * Test-runner caveat: moduleIntegrationTestRunner builds schema from the
 * moduleModels array. Pull has no DB-level FK to Pack/Card (business-key
 * strings only), so only Pull is needed here — see ledger-service
 * .integration.spec.ts for the same minimal-model precedent.
 */

import path from 'path';
import { moduleIntegrationTestRunner } from '@medusajs/test-utils';
import { PACKS_MODULE } from '../index';
import type PacksModuleService from '../service';
import { resolveBuybackRate, FLAT_PERCENT } from '../buyback-rate';
import Pull from '../models/pull';

jest.setTimeout(300 * 1000);

moduleIntegrationTestRunner<PacksModuleService>({
  moduleName: PACKS_MODULE,
  resolve: path.resolve(__dirname, '../../..', 'modules/packs'),
  moduleModels: [Pull],
  testSuite: ({ service }) => {
    const NOW = new Date('2026-08-01T12:00:00Z');

    async function seedOpenPull(customerId: string) {
      const [pull] = await service.createPulls([
        {
          customer_id: customerId,
          pack_id: 'bronze-pack',
          card_id: 'test-charizard',
          order_id: null,
          rolled_at: NOW,
          revealed_at: NOW,
          instant_closed_at: null,
          source: 'pack',
          recorded_value_usd: 100,
        },
      ]);
      return pull!;
    }

    const freshPull = async (id: string) => {
      const [p] = await service.listPulls({ id }, { take: 1 });
      return p!;
    };

    describe('closeInstantWindow', () => {
      it('owner closes own pull: instant_closed_at is stamped and the rate flips to vault', async () => {
        const pull = await seedOpenPull('cus_a');
        const pack = { buyback_percent: 95 };
        // Still inside the window pre-close.
        expect(resolveBuybackRate(pack, pull, NOW.getTime() + 1_000)).toEqual({
          percent: 95,
          rate_type: 'instant',
        });

        const result = await service.closeInstantWindow(
          [pull.id],
          'cus_a',
          NOW.getTime() + 1_000,
        );
        expect(result).toEqual({ closed: 1 });

        const closed = await freshPull(pull.id);
        expect(closed.instant_closed_at).not.toBeNull();
        expect(
          resolveBuybackRate(pack, closed, NOW.getTime() + 2_000),
        ).toEqual({ percent: FLAT_PERCENT, rate_type: 'vault' });
      });

      it("customer B cannot close customer A's pull", async () => {
        const pull = await seedOpenPull('cus_a');

        const result = await service.closeInstantWindow([pull.id], 'cus_b');
        expect(result).toEqual({ closed: 0 });

        const stillOpen = await freshPull(pull.id);
        expect(stillOpen.instant_closed_at).toBeNull();
      });

      it('closing an already-closed pull is a no-op: closed 0, timestamp unchanged', async () => {
        const pull = await seedOpenPull('cus_a');
        await service.closeInstantWindow([pull.id], 'cus_a', NOW.getTime());
        const firstClose = await freshPull(pull.id);
        const stamp = firstClose.instant_closed_at;
        expect(stamp).not.toBeNull(); // guard against a silently-no-op first close

        const second = await service.closeInstantWindow(
          [pull.id],
          'cus_a',
          NOW.getTime() + 60_000,
        );
        expect(second).toEqual({ closed: 0 });

        const stillClosed = await freshPull(pull.id);
        expect(stillClosed.instant_closed_at).toEqual(stamp);
      });

      it('an empty id list is a no-op success', async () => {
        const result = await service.closeInstantWindow([], 'cus_a');
        expect(result).toEqual({ closed: 0 });
      });
    });
  },
});

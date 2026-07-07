import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { deleteCardWorkflow } from '../../src/workflows/delete-card';

jest.setTimeout(240 * 1000);

const PACK_SLUG = 'pst-pack';
const CARD_HANDLE = 'pst-card';

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ getContainer }) => {
    describe('transitionPullStatus — guarded, atomic pull-status flips', () => {
      let packs: PacksModuleService;

      beforeEach(async () => {
        packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        await packs.createPacks([
          {
            slug: PACK_SLUG,
            title: 'PST Pack',
            category: 'pokemon',
            price: 10,
            image: '/cdn/test-pack.webp',
          },
        ]);
        await packs.createCards([
          {
            handle: CARD_HANDLE,
            name: 'PST Card',
            set: 'Test Set',
            grader: 'PSA',
            grade: '10',
            market_value: 50,
            image: '/cdn/test-card.webp',
          },
        ]);
      });

      const mkPull = async (status: 'vaulted' | 'delivering') => {
        const [pull] = await packs.createPulls([
          {
            customer_id: 'cus_pst_test',
            pack_id: PACK_SLUG,
            card_id: CARD_HANDLE,
            order_id: null,
            rolled_at: new Date(),
            status,
          },
        ]);
        return pull;
      };

      it('flips vaulted → bought_back and stamps buyback fields', async () => {
        const pull = await mkPull('vaulted');
        await packs.transitionPullStatus({
          ids: [pull.id],
          from: 'vaulted',
          to: 'bought_back',
          set: { buyback_amount: 216, buyback_at: new Date() },
        });
        const [fresh] = await packs.listPulls({ id: pull.id }, { take: 1 });
        expect(fresh.status).toBe('bought_back');
        expect(Number(fresh.buyback_amount)).toBe(216);
        expect(fresh.buyback_at).toBeTruthy();
      });

      it('throws when the pull is not in `from` (stale read simulation)', async () => {
        const pull = await mkPull('delivering');
        await expect(
          packs.transitionPullStatus({
            ids: [pull.id],
            from: 'vaulted',
            to: 'bought_back',
          }),
        ).rejects.toThrow(/changed state/i);
        const [fresh] = await packs.listPulls({ id: pull.id }, { take: 1 });
        expect(fresh.status).toBe('delivering'); // untouched
      });

      it('is all-or-nothing on a mixed batch (rollback proof)', async () => {
        const good = await mkPull('vaulted');
        const bad = await mkPull('delivering');
        await expect(
          packs.transitionPullStatus({
            ids: [good.id, bad.id],
            from: 'vaulted',
            to: 'delivering',
          }),
        ).rejects.toThrow(/changed state/i);
        // The matching row must have been rolled back too.
        const [freshGood] = await packs.listPulls({ id: good.id }, { take: 1 });
        expect(freshGood.status).toBe('vaulted');
      });

      describe('deleteCardStep — vault guard', () => {
        it('refuses to delete a card customers still hold', async () => {
          const pull = await mkPull('vaulted');
          void pull;
          // Workflow engine errors surface as deserialized plain objects (not
          // real Error instances) by the time .run() rethrows them, so
          // .rejects.toThrow() (which requires isError()) can't see them —
          // match on the message shape instead.
          await expect(
            deleteCardWorkflow(getContainer()).run({
              input: { handle: CARD_HANDLE },
            }),
          ).rejects.toMatchObject({ message: expect.stringMatching(/still hold/i) });
          const [card] = await packs.listCards(
            { handle: CARD_HANDLE },
            { take: 1 },
          );
          expect(card).toBeTruthy(); // not deleted
        });
      });
    });
  },
});

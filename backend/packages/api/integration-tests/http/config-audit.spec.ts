import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { updatePackWorkflow } from '../../src/workflows/update-pack';
import { savePackOddsWorkflow } from '../../src/workflows/save-pack-odds';

jest.setTimeout(240 * 1000);

// Config-change trail (2026-09-30), against the real DB: every pack / odds save
// leaves a before/after admin_action_audit row (which also proves the widened
// CHECK constraints accept the new values), and a save whose audit row cannot
// be written is rolled back — no config change lands without a record.

const PACK_SLUG = 'cfg-audit-pack';
const ADMIN = 'user_cfg_audit';

const writeInput = (overrides: Record<string, unknown> = {}) => ({
  slug: PACK_SLUG,
  title: 'Config Audit Pack',
  category: 'pokemon',
  price: 300,
  image: '/cdn/cfg.webp',
  buyback_percent: 90,
  boost: false,
  rank: 0,
  status: 'draft' as const,
  admin_id: ADMIN,
  ...overrides,
});

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ getContainer }) => {
    describe('config-change audit trail', () => {
      let packs: PacksModuleService;

      beforeEach(async () => {
        packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        await packs.createPacks([
          {
            slug: PACK_SLUG,
            title: 'Config Audit Pack',
            category: 'pokemon',
            price: 300,
            image: '/cdn/cfg.webp',
            buyback_percent: 90,
            status: 'draft',
          },
        ]);
        await packs.createCards([
          {
            handle: 'cfg-rare',
            name: 'Cfg Rare',
            set: 'Test',
            grader: 'PSA',
            grade: '10',
            market_value: 100,
            image: '/cdn/r.webp',
          },
          {
            handle: 'cfg-common',
            name: 'Cfg Common',
            set: 'Test',
            grader: 'PSA',
            grade: '10',
            market_value: 5,
            image: '/cdn/c.webp',
          },
        ]);
        await packs.createPackOdds([
          {
            pack_id: PACK_SLUG,
            card_id: 'cfg-rare',
            rarity: 'Rare',
            weight: 220_000,
            locked: false,
          },
          {
            pack_id: PACK_SLUG,
            card_id: 'cfg-common',
            rarity: 'Common',
            weight: 780_000,
            locked: false,
          },
        ]);
      });

      afterEach(() => jest.restoreAllMocks());

      const auditsFor = (action: string) =>
        packs.listAdminActionAudits(
          { entity_type: 'pack', entity_id: PACK_SLUG, action },
          { take: 10 },
        );

      it('records a buyback-rate change with before and after', async () => {
        await updatePackWorkflow(getContainer()).run({
          input: writeInput({ buyback_percent: 100 }),
        });

        const [row] = await auditsFor('edit');
        expect(row).toBeTruthy();
        expect(row.admin_id).toBe(ADMIN);
        expect(
          (row.before as { buyback_percent: number }).buyback_percent,
        ).toBe(90);
        expect((row.after as { buyback_percent: number }).buyback_percent).toBe(
          100,
        );
      });

      it('rolls the pack edit back when its audit row cannot be written', async () => {
        jest
          .spyOn(packs, 'createAdminActionAudits')
          .mockRejectedValueOnce(new Error('audit store unavailable'));

        await expect(
          updatePackWorkflow(getContainer()).run({
            input: writeInput({ buyback_percent: 100 }),
          }),
        ).rejects.toMatchObject({
          message: expect.stringMatching(/audit store unavailable/),
        });

        const [pack] = await packs.listPacks({ slug: PACK_SLUG }, { take: 1 });
        expect(pack.buyback_percent).toBe(90);
      });

      it('records an odds save and rolls it back (target RTP included) when the audit fails', async () => {
        const entries = [
          {
            card_id: 'cfg-rare',
            rarity: 'Rare',
            pct: 30,
            locked: false,
            pct_2: null,
            pct_3: null,
          },
          {
            card_id: 'cfg-common',
            rarity: 'Common',
            pct: 0,
            locked: false,
            pct_2: null,
            pct_3: null,
          },
        ];

        // A failed audit write: odds AND target RTP stay as they were.
        jest
          .spyOn(packs, 'createAdminActionAudits')
          .mockRejectedValueOnce(new Error('audit store unavailable'));
        await expect(
          savePackOddsWorkflow(getContainer()).run({
            input: {
              pack_id: PACK_SLUG,
              entries,
              target_rtp_bps: 8000,
              admin_id: ADMIN,
            },
          }),
        ).rejects.toMatchObject({
          message: expect.stringMatching(/audit store unavailable/),
        });
        const rareAfterFail = await packs.listPackOdds(
          { pack_id: PACK_SLUG, card_id: 'cfg-rare' },
          { take: 1 },
        );
        expect(rareAfterFail[0].weight).toBe(220_000);
        const [packAfterFail] = await packs.listPacks(
          { slug: PACK_SLUG },
          { take: 1 },
        );
        expect(packAfterFail.target_rtp_bps).toBe(7000);

        // The same save with the audit working lands and is recorded.
        jest.restoreAllMocks();
        await savePackOddsWorkflow(getContainer()).run({
          input: {
            pack_id: PACK_SLUG,
            entries,
            target_rtp_bps: 8000,
            admin_id: ADMIN,
          },
        });
        const [row] = await auditsFor('edit_odds');
        expect(row).toBeTruthy();
        const rareWeight = (side: unknown) =>
          (side as { odds: { card_id: string; weight: number }[] }).odds.find(
            (o) => o.card_id === 'cfg-rare',
          )?.weight;
        expect(rareWeight(row.before)).toBe(220_000);
        expect(rareWeight(row.after)).toBe(300_000);
        expect(row.before).toMatchObject({ target_rtp_bps: 7000 });
        expect(row.after).toMatchObject({ target_rtp_bps: 8000 });
      });
    });
  },
});

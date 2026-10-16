/**
 * Lossless Mode schedule table + service methods — integration:modules
 *
 * The routes (Task 3) and the pricing path (Task 4+) sit on three service
 * methods; this pins the contract they rely on against a real Postgres:
 * the row and its audit land together, `losslessWindows` hands back plain
 * LosslessWindow objects (pack_slugs as an array or null, not a JSON string),
 * and a cancel is refused once the window is over or already cancelled.
 */

import path from 'path';
import { moduleIntegrationTestRunner } from '@medusajs/test-utils';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../index';
import type PacksModuleService from '../service';
import LosslessSchedule from '../models/lossless-schedule';
import AdminActionAudit from '../models/admin-action-audit';

jest.setTimeout(300 * 1000);

const HOUR = 60 * 60 * 1000;

moduleIntegrationTestRunner<PacksModuleService>({
  moduleName: PACKS_MODULE,
  resolve: path.resolve(__dirname, '../../..', 'modules/packs'),
  // A modules-type spec builds its schema from THIS array, never from the
  // migrations — both tables the operations write have to be listed.
  moduleModels: [LosslessSchedule, AdminActionAudit],
  testSuite: ({ service }) => {
    const auditsFor = (entityId: string) =>
      service.listAdminActionAudits(
        { entity_type: 'pack', entity_id: entityId },
        { take: 10, order: { created_at: 'ASC' } },
      );

    const create = (
      over: Partial<{
        startsAt: Date;
        endsAt: Date;
        packSlugs: string[] | null;
        adminId: string;
        reason: string;
      }> = {},
    ) =>
      service.createLosslessSchedule({
        startsAt: new Date(Date.now() - HOUR),
        endsAt: new Date(Date.now() + HOUR),
        packSlugs: null,
        adminId: 'admin_ll_1',
        reason: 'weekend promo',
        ...over,
      });

    it('creates the row and its audit together', async () => {
      const startsAt = new Date(Date.now() - HOUR);
      const endsAt = new Date(Date.now() + HOUR);
      const { id } = await create({ startsAt, endsAt });

      const [row] = await service.listLosslessSchedules({ id }, { take: 1 });
      expect(row.pack_slugs).toBeNull();
      expect(row.cancelled_at).toBeNull();
      expect(row.created_by).toBe('admin_ll_1');
      expect(new Date(row.starts_at).getTime()).toBe(startsAt.getTime());
      expect(new Date(row.ends_at).getTime()).toBe(endsAt.getTime());

      const audits = await auditsFor(id);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        admin_id: 'admin_ll_1',
        entity_type: 'pack',
        entity_id: id,
        action: 'create',
        reason: 'weekend promo',
      });
      expect(audits[0].before).toBeNull();
      expect(audits[0].after).toMatchObject({
        kind: 'lossless_schedule',
        starts_at: startsAt.toISOString(),
        ends_at: endsAt.toISOString(),
        pack_slugs: null,
      });
    });

    it('losslessWindows returns un-ended windows and skips ended ones', async () => {
      const live = await create();
      const ended = await create({
        startsAt: new Date(Date.now() - 3 * HOUR),
        endsAt: new Date(Date.now() - HOUR),
      });

      const windows = await service.losslessWindows(Date.now());
      const ids = windows.map((w) => w.id);
      expect(ids).toContain(live.id);
      expect(ids).not.toContain(ended.id);

      const w = windows.find((x) => x.id === live.id)!;
      expect(Object.keys(w).sort()).toEqual([
        'cancelled_at',
        'ends_at',
        'id',
        'pack_slugs',
        'starts_at',
      ]);
      expect(w.pack_slugs).toBeNull();
      expect(w.cancelled_at).toBeNull();
    });

    it('round-trips pack_slugs as an array', async () => {
      const { id } = await create({ packSlugs: ['gold-pack'] });

      const [row] = await service.listLosslessSchedules({ id }, { take: 1 });
      expect(row.pack_slugs).toEqual(['gold-pack']);
      const w = (await service.losslessWindows(Date.now())).find(
        (x) => x.id === id,
      )!;
      expect(w.pack_slugs).toEqual(['gold-pack']);
      const [audit] = await auditsFor(id);
      expect(audit.after).toMatchObject({ pack_slugs: ['gold-pack'] });
    });

    it('cancels a live window once, with an audit row', async () => {
      const { id } = await create();

      const before = Date.now();
      const out = await service.cancelLosslessSchedule({
        id,
        adminId: 'admin_ll_2',
        reason: 'ended the promo early',
      });
      const after = Date.now();

      expect(out.id).toBe(id);
      expect(out.cancelled_at.getTime()).toBeGreaterThanOrEqual(before - 1000);
      expect(out.cancelled_at.getTime()).toBeLessThanOrEqual(after + 1000);
      const [row] = await service.listLosslessSchedules({ id }, { take: 1 });
      expect(new Date(row.cancelled_at!).getTime()).toBe(
        out.cancelled_at.getTime(),
      );

      const audits = await auditsFor(id);
      expect(audits.map((a) => a.action)).toEqual(['create', 'disable']);
      expect(audits[1]).toMatchObject({
        admin_id: 'admin_ll_2',
        entity_type: 'pack',
        entity_id: id,
        reason: 'ended the promo early',
      });
      expect(audits[1].before).toMatchObject({
        id,
        pack_slugs: null,
        cancelled_at: null,
      });
      expect(audits[1].after).toEqual({
        kind: 'lossless_schedule',
        cancelled_at: out.cancelled_at.toISOString(),
      });

      await expect(
        service.cancelLosslessSchedule({
          id,
          adminId: 'admin_ll_2',
          reason: 'again',
        }),
      ).rejects.toMatchObject({
        type: MedusaError.Types.NOT_ALLOWED,
        message: 'This schedule already ended or was cancelled.',
      });
      // The refused cancel wrote nothing.
      expect(await auditsFor(id)).toHaveLength(2);
    });

    it('refuses to cancel a window that already ended', async () => {
      const { id } = await create({
        startsAt: new Date(Date.now() - 3 * HOUR),
        endsAt: new Date(Date.now() - HOUR),
      });

      await expect(
        service.cancelLosslessSchedule({
          id,
          adminId: 'admin_ll_3',
          reason: 'too late',
        }),
      ).rejects.toMatchObject({
        type: MedusaError.Types.NOT_ALLOWED,
        message: 'This schedule already ended or was cancelled.',
      });
      const [row] = await service.listLosslessSchedules({ id }, { take: 1 });
      expect(row.cancelled_at).toBeNull();
    });

    it('cancels an upcoming window', async () => {
      const { id } = await create({
        startsAt: new Date(Date.now() + HOUR),
        endsAt: new Date(Date.now() + 2 * HOUR),
      });

      const out = await service.cancelLosslessSchedule({
        id,
        adminId: 'admin_ll_4',
        reason: 'not needed',
      });
      expect(out.id).toBe(id);
    });

    it('reports an unknown id as NOT_FOUND', async () => {
      await expect(
        service.cancelLosslessSchedule({
          id: 'lossless_missing',
          adminId: 'admin_ll_5',
          reason: 'nope',
        }),
      ).rejects.toMatchObject({
        type: MedusaError.Types.NOT_FOUND,
        message: 'Lossless schedule not found.',
      });
    });
  },
});

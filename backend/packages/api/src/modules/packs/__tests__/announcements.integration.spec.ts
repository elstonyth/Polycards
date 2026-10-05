import path from 'path';
import { moduleIntegrationTestRunner } from '@medusajs/test-utils';
import { PACKS_MODULE } from '../index';
import type PacksModuleService from '../service';
import Announcement from '../models/announcement';
import AdminActionAudit from '../models/admin-action-audit';

jest.setTimeout(300 * 1000);

// The service half the unit suite cannot reach: real rows, the audit insert
// against the Postgres CHECK, the soft delete, and updated_at moving on edit
// (the storefront's dismissal signature depends on it).
moduleIntegrationTestRunner<PacksModuleService>({
  moduleName: PACKS_MODULE,
  resolve: path.resolve(__dirname, '../../..', 'modules/packs'),
  moduleModels: [Announcement, AdminActionAudit],
  testSuite: ({ service }) => {
    const base = {
      image_url: 'https://cdn.example.com/drop.webp',
      title: 'Base Set drop',
      link_url: '/slots/base-set',
      active: true,
      sort: 0,
      adminId: 'admin_1',
      reason: 'seed',
    };

    it('save creates a row and an audit row that passes the CHECK', async () => {
      const { id } = await service.saveAnnouncement(base);
      expect(id).toMatch(/^ann_/);

      const [row] = await service.listAnnouncements({ id });
      expect(row).toMatchObject({
        image_url: base.image_url,
        title: base.title,
        link_url: base.link_url,
        active: true,
        sort: 0,
      });
      const audits = await service.listAdminActionAudits({
        entity_type: 'announcement',
        entity_id: id,
      });
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ action: 'create', reason: 'seed' });
    });

    it('an edit bumps updated_at and is audited as edit', async () => {
      const { id } = await service.saveAnnouncement(base);
      const [before] = await service.listAnnouncements({ id });
      await new Promise((r) => setTimeout(r, 25));

      await service.saveAnnouncement({ ...base, id, title: 'Edited' });
      const [after] = await service.listAnnouncements({ id });
      expect(after.title).toBe('Edited');
      expect(new Date(after.updated_at).getTime()).toBeGreaterThan(
        new Date(before.updated_at).getTime(),
      );
      const actions = (
        await service.listAdminActionAudits({
          entity_type: 'announcement',
          entity_id: id,
        })
      ).map((a) => a.action);
      expect(actions.sort()).toEqual(['create', 'edit']);
    });

    it('delete soft-deletes, drops the row from the live set, and audits', async () => {
      const { id } = await service.saveAnnouncement(base);
      expect((await service.liveAnnouncements()).map((a) => a.id)).toContain(
        id,
      );

      await service.deleteAnnouncement({ id, adminId: 'admin_1', reason: 'x' });
      expect(await service.listAnnouncements({ id })).toHaveLength(0);
      const [deleted] = await service.listAnnouncements(
        { id },
        { withDeleted: true },
      );
      expect(deleted.deleted_at).not.toBeNull();
      expect(
        (await service.liveAnnouncements()).map((a) => a.id),
      ).not.toContain(id);
      const audits = await service.listAdminActionAudits({
        entity_type: 'announcement',
        entity_id: id,
        action: 'delete',
      });
      expect(audits).toHaveLength(1);
    });

    it('excludes inactive and out-of-window rows from the live set', async () => {
      const now = Date.now();
      const live = await service.saveAnnouncement({ ...base, sort: 1 });
      const off = await service.saveAnnouncement({ ...base, active: false });
      const future = await service.saveAnnouncement({
        ...base,
        startsAt: new Date(now + 3_600_000),
      });
      const ended = await service.saveAnnouncement({
        ...base,
        startsAt: new Date(now - 7_200_000),
        endsAt: new Date(now - 3_600_000),
      });

      const ids = (await service.liveAnnouncements()).map((a) => a.id);
      expect(ids).toContain(live.id);
      for (const hidden of [off, future, ended]) {
        expect(ids).not.toContain(hidden.id);
      }
    });

    it('editing or deleting an already-deleted id is NOT_FOUND', async () => {
      const { id } = await service.saveAnnouncement(base);
      await service.deleteAnnouncement({ id, adminId: 'admin_1', reason: 'x' });

      await expect(
        service.saveAnnouncement({ ...base, id, title: 'Back from the dead' }),
      ).rejects.toMatchObject({ type: 'not_found' });
      await expect(
        service.deleteAnnouncement({ id, adminId: 'admin_1', reason: 'x' }),
      ).rejects.toMatchObject({ type: 'not_found' });
    });
  },
});

import type { MedusaContainer } from '@medusajs/framework/types';
import { PACKS_MODULE } from '../../../modules/packs';
import { recordAdminAuditInvoke } from '../record-admin-audit';
import { configAuditRow } from '../../../modules/packs/config-audit';

const containerWith = (packs: object) =>
  ({
    resolve: (key: string) => {
      if (key === PACKS_MODULE) return packs;
      throw new Error(`unexpected resolve ${key}`);
    },
  }) as unknown as MedusaContainer;

describe('record-admin-audit step', () => {
  it('writes the row it is given', async () => {
    const createAdminActionAudits = jest.fn().mockResolvedValue([]);
    const row = configAuditRow({
      adminId: 'user_1',
      entityType: 'pack',
      entityId: 'bronze-pack',
      action: 'edit',
      before: { buyback_percent: 90 },
      after: { buyback_percent: 100 },
    });

    await recordAdminAuditInvoke(row, {
      container: containerWith({ createAdminActionAudits }),
    });

    expect(createAdminActionAudits).toHaveBeenCalledWith([row]);
  });

  it('writes nothing when the change turned out to be a no-op', async () => {
    const createAdminActionAudits = jest.fn();

    await recordAdminAuditInvoke(null, {
      container: containerWith({ createAdminActionAudits }),
    });

    expect(createAdminActionAudits).not.toHaveBeenCalled();
  });

  it('fails loudly when the row cannot be written, so the workflow rolls back', async () => {
    const createAdminActionAudits = jest
      .fn()
      .mockRejectedValue(new Error('violates check constraint'));
    const row = configAuditRow({
      adminId: 'user_1',
      entityType: 'pack',
      entityId: 'bronze-pack',
      action: 'edit',
      before: null,
      after: null,
    });

    await expect(
      recordAdminAuditInvoke(row, {
        container: containerWith({ createAdminActionAudits }),
      }),
    ).rejects.toThrow(/check constraint/);
  });
});

import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { Modules } from '@medusajs/framework/utils';
import type { ICustomerModuleService } from '@medusajs/framework/types';
import { PACKS_MODULE } from '../../../modules/packs';
import type PacksModuleService from '../../../modules/packs/service';
import { resolveFxRate } from '../../../modules/packs/pricing';
import { monitoredCustomerIds } from '../../utils/automation-monitor';
import type { AutomationMonitorSnapshot } from '../../utils/automation-monitor-types';

export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const [saved] = await packs.listAutomationMonitors(
    { id: 'global' },
    { take: 1 },
  );
  const ids = monitoredCustomerIds(saved?.accounts);
  const customers = req.scope.resolve<ICustomerModuleService>(Modules.CUSTOMER);
  const found = ids.length
    ? await customers.listCustomers(
        { id: ids },
        {
          select: ['id', 'email', 'first_name', 'last_name'],
          take: ids.length,
        },
      )
    : [];
  const byId = new Map(found.map((customer) => [customer.id, customer]));
  const overview = await packs.playersOverview(
    found.map((customer) => customer.id),
    await resolveFxRate(packs),
  );
  const body: AutomationMonitorSnapshot = {
    mode: 'read-only',
    automationEnabled: false,
    updatedAt: new Date().toISOString(),
    accounts: ids.map((id) => {
      const customer = byId.get(id);
      const state = overview.state.get(id);
      return {
        id,
        name: customer
          ? [customer.first_name, customer.last_name]
              .filter(Boolean)
              .join(' ') || null
          : null,
        email: customer?.email ?? null,
        balance: customer
          ? (overview.wallet.get(id)?.balanceCents ?? 0) / 100
          : null,
        status: !customer
          ? 'unavailable'
          : state?.disabled
            ? 'disabled'
            : state?.frozen
              ? 'frozen'
              : 'active',
      };
    }),
  };
  res.json(body);
}

import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import type { ICustomerModuleService } from '@medusajs/framework/types';
import { MedusaError, Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../../modules/packs';
import type PacksModuleService from '../../../../modules/packs/service';
import { RARITY_ORDER } from '../../../../modules/packs/rarity';
import { monitoredCustomerIds } from '../../../utils/automation-monitor';
import type { AutomationActivity } from '../../../utils/automation-live-types';

const DAY_MS = 86_400_000;
const WINDOWS = [1, 7, 30];
/** "Legendary and above" — the big hits the dashboard lists one by one. */
const HIT_TIERS = RARITY_ORDER.slice(0, RARITY_ORDER.indexOf('Legendary') + 1);

// GET /admin/automation/activity?days=1|7|30 — what the Automation Accounts
// drew: per MYT day, per tier, per account, and the newest Legendary+ hits.
// Admin-only (automation:read via admin-rbac's /admin/automation/* rule).
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const days = req.query.days === undefined ? 7 : Number(req.query.days);
  if (!WINDOWS.includes(days))
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'Days must be 1, 7 or 30.',
    );
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const [saved] = await packs.listAutomationMonitors(
    { id: 'global' },
    { take: 1 },
  );
  const ids = monitoredCustomerIds(saved?.accounts);
  const [activity, customers] = await Promise.all([
    packs.automationActivity({
      customerIds: ids,
      sinceMs: Date.now() - days * DAY_MS,
      hitTiers: [...HIT_TIERS],
      hitLimit: 100,
    }),
    ids.length
      ? req.scope
          .resolve<ICustomerModuleService>(Modules.CUSTOMER)
          .listCustomers(
            { id: ids },
            { select: ['id', 'email', 'first_name', 'last_name'], take: 80 },
          )
      : [],
  ]);
  const names = Object.fromEntries(
    customers.map((customer) => [
      customer.id,
      [customer.first_name, customer.last_name].filter(Boolean).join(' ') ||
        customer.email,
    ]),
  );
  const body: AutomationActivity = {
    windowDays: days,
    hitTiers: [...HIT_TIERS],
    names,
    ...activity,
  };
  res.json(body);
}

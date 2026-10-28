import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError, Modules } from '@medusajs/framework/utils';
import type { ICustomerModuleService } from '@medusajs/framework/types';
import { PACKS_MODULE } from '../../../../modules/packs';
import type PacksModuleService from '../../../../modules/packs/service';
import { monitoredEmails } from '../../../utils/automation-monitor';

// Saves references to existing customers. Never logs in as them or changes them.
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const emails = monitoredEmails(req.body);
  const customers = req.scope.resolve<ICustomerModuleService>(Modules.CUSTOMER);
  const matches = await customers.listCustomers(
    { email: emails, has_account: true },
    { select: ['id', 'email'], take: 80 },
  );
  const byEmail = new Map(
    matches.map((customer) => [customer.email.toLowerCase(), customer.id]),
  );
  if (
    byEmail.size !== emails.length ||
    emails.some((email) => !byEmail.has(email))
  ) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'Every email must match one existing registered account. Nothing was saved.',
    );
  }
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const data = {
    accounts: { customer_ids: emails.map((email) => byEmail.get(email)!) },
    updated_by: req.auth_context.actor_id,
  };
  const [saved] = await packs.listAutomationMonitors(
    { id: 'global' },
    { take: 1 },
  );
  if (saved) await packs.updateAutomationMonitors({ id: 'global', ...data });
  else await packs.createAutomationMonitors({ id: 'global', ...data });
  res.json({
    mode: 'read-only',
    automationEnabled: false,
    count: emails.length,
  });
}

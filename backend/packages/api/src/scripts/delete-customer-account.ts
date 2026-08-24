import { ExecArgs } from '@medusajs/framework/types';
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../modules/packs';
import type PacksModuleService from '../modules/packs/service';
import { purgeAndDeleteAccount } from '../api/utils/account-deletion';

/**
 * Operator-initiated account deletion — the admin counterpart to
 * POST /store/customers/me/delete. Runs the exact same purge
 * (purgeAndDeleteAccount, api/utils/account-deletion.ts) that route runs, so
 * an operator deletion destroys PII and retains anonymous books identically
 * to a self-service one (docs/adr/0006-account-deletion-destroys-pii-retains-
 * anonymous-books.md). It never bypasses deleteAccountPreflight — this script
 * skips only the customer's own password proof; running this script AT ALL is
 * the operator's proof of intent.
 *
 * DRY RUN BY DEFAULT — resolves the account, prints identity + preflight
 * verdict, writes nothing:
 *   DELETE_CUSTOMER_ID=cus_xxx corepack yarn medusa exec ./src/scripts/delete-customer-account.ts
 *
 * APPLY — CONFIRM_DELETE must equal DELETE_CUSTOMER_ID EXACTLY (never "yes"
 * or "1"): the guard against deleting the wrong account after an env-var
 * slip.
 *   DELETE_CUSTOMER_ID=cus_xxx CONFIRM_DELETE=cus_xxx corepack yarn medusa exec ./src/scripts/delete-customer-account.ts
 *
 * PII: phone masked to its last 4 (same rule as inspect-duplicate-phone-
 * pair.ts), email reduced to a shape hint. Neither is ever printed whole.
 */
const mask = (phone?: string | null): string =>
  phone ? `••••${phone.slice(-4)}` : '(none)';

const emailHint = (email?: string | null): string => {
  if (!email) return '(none)';
  const [local, domain] = email.split('@');
  if (!domain) return '(malformed)';
  return `${local.slice(0, 1)}${'*'.repeat(Math.max(1, local.length - 1))}@${domain}`;
};

export default async function deleteCustomerAccount({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const customerId = process.env.DELETE_CUSTOMER_ID?.trim();
  if (!customerId) {
    logger.error(
      '[delete-customer-account] DELETE_CUSTOMER_ID unset — pass the customer id to inspect/delete.',
    );
    return;
  }

  const customers = container.resolve(Modules.CUSTOMER);
  const packs = container.resolve<PacksModuleService>(PACKS_MODULE);

  const customer = await customers
    .retrieveCustomer(customerId, {
      select: ['id', 'email', 'phone', 'has_account'],
    })
    .catch(() => null);
  if (!customer) {
    logger.error(
      `[delete-customer-account] ${customerId} does not resolve — nothing to do.`,
    );
    return;
  }

  // Exact total, not a capped page presented as complete — same discipline as
  // inspect-duplicate-phone-pair.ts's readActivity.
  const [, pullCount] = await packs.listAndCountPulls(
    { customer_id: customerId },
    { skip: 0, take: 1 },
  );
  const preflight = await packs.deleteAccountPreflight(customerId);

  logger.info(
    [
      `[delete-customer-account] ${customer.id}`,
      `  has_account  ${customer.has_account}`,
      `  phone        ${mask(customer.phone)}`,
      `  email        ${emailHint(customer.email)}`,
      `  pulls        ${pullCount}`,
      `  preflight    ${
        preflight.ok
          ? 'OK — deletable'
          : `BLOCKED: ${preflight.reason} — ${preflight.detail}`
      }`,
    ].join('\n'),
  );

  const confirm = process.env.CONFIRM_DELETE?.trim();
  if (confirm !== customerId) {
    logger.info(
      `[delete-customer-account] DRY RUN — nothing written. CONFIRM_DELETE is ` +
        `${confirm ? `'${confirm}'` : 'unset'}; set it to '${customerId}' ` +
        `EXACTLY to delete this account.`,
    );
    return;
  }

  logger.info(
    `[delete-customer-account] CONFIRM_DELETE matched — deleting ${customerId}.`,
  );
  // Never bypass the preflight: purgeAndDeleteAccount re-runs it and writes
  // nothing when refused, same as the self-service route.
  const result = await purgeAndDeleteAccount(container, customerId);
  if (!result.ok) {
    logger.error(
      `[delete-customer-account] REFUSED: ${result.reason} — ${result.detail}`,
    );
    throw new Error(
      `[delete-customer-account] refused: ${result.reason} — ${result.detail}`,
    );
  }

  const after = await customers
    .retrieveCustomer(customerId, {
      withDeleted: true,
      select: ['id', 'phone'],
    })
    .catch(() => null);
  logger.info(
    `[delete-customer-account] DONE — ${customerId} deleted. phone ` +
      `${mask(customer.phone)} -> ${mask(after?.phone ?? null)}`,
  );
}

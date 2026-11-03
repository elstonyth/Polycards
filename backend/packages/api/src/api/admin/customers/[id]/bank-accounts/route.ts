import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../../../modules/packs';
import {
  MY_BANKS,
  SG_BANKS,
  findBank,
} from '../../../../../modules/packs/banks';
import {
  clearedHolderNames,
  heldByAnother,
  parseSavedBankAccounts,
  verifiedBankAccounts,
} from '../../../../../modules/packs/saved-accounts';
import type PacksModuleService from '../../../../../modules/packs/service';

type LinkedCustomer = { customer_id: string; handle: string | null };

// GET /admin/customers/:id/bank-accounts — what this player withdraws to, who
// else is on each number, and whether support verified the player (ADR 0015).
// Carries FULL account numbers: fenced by SECRET_READS (admin-rbac.ts), throttled
// in middlewares.ts, and audited like the payout-details GET it sits beside.
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const customerId = req.params.id;
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const customers = req.scope.resolve(Modules.CUSTOMER);
  const customer = await customers.retrieveCustomer(customerId);
  const metadata = (customer.metadata ?? {}) as Record<string, unknown>;
  const accounts = parseSavedBankAccounts(metadata.bank_accounts);
  const verified = verifiedBankAccounts(metadata);

  const holders = await Promise.all(
    accounts.map(async (account) =>
      (
        await packs.otherPayoutAccountHolders(
          customerId,
          account.accountNumber,
          findBank(account.bankCode)?.wallet !== undefined,
        )
      ).filter((h) => heldByAnother([h], account.bankCode)),
    ),
  );
  const cleared = Object.values(clearedHolderNames(metadata));
  const linkedIds = [
    ...new Set([
      ...holders.flat().map((h) => h.customer_id),
      ...cleared.flatMap((c) => c.with),
    ]),
  ];
  const handles = new Map(
    linkedIds.length === 0
      ? []
      : (
          await customers.listCustomers(
            { id: linkedIds },
            { select: ['id', 'metadata'], take: linkedIds.length },
          )
        ).map((c) => [
          c.id,
          typeof c.metadata?.handle === 'string' ? c.metadata.handle : null,
        ]),
  );

  if (accounts.length > 0) {
    try {
      await packs.createAdminActionAudits([
        {
          admin_id: req.auth_context.actor_id,
          entity_type: 'customer',
          entity_id: customerId,
          action: 'reveal',
          before: null,
          // Same last-4 rule as payout-details: the audit feed must never carry
          // the full number it records the disclosure of.
          after: {
            account_last4: accounts.map((a) => a.accountNumber.slice(-4)),
          },
          reason: 'saved bank accounts revealed',
        },
      ]);
    } catch {
      // Never fail the read on an audit write.
    }
  }

  res.setHeader('Cache-Control', 'no-store');
  res.json({
    // What support can add for a player with none. Banks only: a wallet's owner
    // can save it themselves unless someone was already paid to it.
    banks: [...MY_BANKS, ...SG_BANKS].map((b) => ({ id: b.id, name: b.name })),
    // This player's numbers on the ban list (bank-accounts/unban-number).
    banned_numbers: (await packs.bannedPayoutAccountsOf(customerId)).map(
      (b) => ({
        bank_code: b.bank_code,
        bank_name: findBank(b.bank_code)?.name ?? b.bank_code,
        last4: b.last4,
      }),
    ),
    // Names support cleared as two real people's (bank-accounts/name-clash).
    cleared_names: cleared.map((c) => ({
      name: c.name,
      cleared_at: c.at,
      with: c.with.map<LinkedCustomer>((id) => ({
        customer_id: id,
        handle: handles.get(id) ?? null,
      })),
    })),
    accounts: accounts.map((account, i) => ({
      id: account.id,
      bank_name: account.bankName,
      account_number: account.accountNumber,
      account_holder_name: account.accountHolderName,
      saved_at: account.savedAt ?? null,
      verified_at: verified[account.id] ?? null,
      linked: [
        ...new Set(holders[i].map((h) => h.customer_id)),
      ].map<LinkedCustomer>((id) => ({
        customer_id: id,
        handle: handles.get(id) ?? null,
      })),
    })),
  });
}

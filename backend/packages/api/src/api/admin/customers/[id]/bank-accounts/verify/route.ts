import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError, Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../../../../modules/packs';
import {
  accountNumberForms,
  findBank,
} from '../../../../../../modules/packs/banks';
import {
  heldByAnother,
  parseSavedBankAccounts,
  verifiedElsewhere,
} from '../../../../../../modules/packs/saved-accounts';
import type PacksModuleService from '../../../../../../modules/packs/service';

type Body = { account_id?: unknown; verified?: unknown; reason?: unknown };

// POST /admin/customers/:id/bank-accounts/verify — support checked this player
// and lifts the shared-bank hold on one saved number (ADR 0015). `verified: false`
// puts it back. One person, one account: other accounts on the number stay held, a
// second account on it cannot be verified while the first is, and a number nobody
// else holds has nothing to verify. Two supports verifying in the same instant can
// both pass; that race is not worth a lock on a hand-run action.
export async function POST(
  req: AuthenticatedMedusaRequest<Body>,
  res: MedusaResponse,
): Promise<void> {
  const { account_id: accountId, verified, reason } = req.body ?? {};
  if (typeof accountId !== 'string' || accountId === '') {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'Say which saved account to verify.',
    );
  }
  if (typeof verified !== 'boolean') {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'verified must be true or false.',
    );
  }
  if (
    typeof reason !== 'string' ||
    reason.trim() === '' ||
    reason.length > 500
  ) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'A reason (1–500 chars) is required.',
    );
  }
  const customerId = req.params.id;
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);

  if (verified) {
    const customers = req.scope.resolve(Modules.CUSTOMER);
    const customer = await customers.retrieveCustomer(customerId);
    const account = parseSavedBankAccounts(
      customer.metadata?.bank_accounts,
    ).find((a) => a.id === accountId);
    if (!account) {
      throw new MedusaError(
        MedusaError.Types.NOT_FOUND,
        'That bank account is no longer on this player.',
      );
    }
    // A PayNow mobile is one number with or without its 65.
    const holders = (
      await Promise.all(
        accountNumberForms(account.bankCode, account.accountNumber).map((n) =>
          packs.otherPayoutAccountHolders(
            customerId,
            n,
            findBank(account.bankCode)?.wallet !== undefined,
          ),
        ),
      )
    )
      .flat()
      .filter((h) => heldByAnother([h], account.bankCode));
    const others = [...new Set(holders.map((h) => h.customer_id))];
    if (others.length === 0) {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        'No other account holds this bank account, so there is nothing to verify.',
      );
    }
    const alreadyVerified = (
      await customers.listCustomers(
        { id: others },
        { select: ['id', 'metadata'], take: others.length },
      )
    ).find((c) => verifiedElsewhere(c.metadata ?? {}, account));
    if (alreadyVerified) {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        `One person, one account: ${alreadyVerified.metadata?.handle ?? alreadyVerified.id} is already verified on this bank account. Undo that first if this is the right account.`,
      );
    }
  }

  await packs.setBankShareVerified({
    customerId,
    adminId: req.auth_context.actor_id,
    accountId,
    verified,
    reason: reason.trim(),
  });
  res.json({ verified });
}

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError, Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../../../../modules/packs';
import { findBank } from '../../../../../../modules/packs/banks';
import {
  bankShareVerified,
  heldByAnother,
  parseSavedBankAccounts,
} from '../../../../../../modules/packs/saved-accounts';
import type PacksModuleService from '../../../../../../modules/packs/service';

type Body = { verified?: unknown; reason?: unknown };

// POST /admin/customers/:id/bank-accounts/verify — support checked this player
// and lifts the shared-bank hold for them, at save and at payout (ADR 0015).
// `verified: false` puts it back. One person, one account: other accounts on the
// number stay held, and a second account on it cannot be verified while the first
// is. Two supports verifying in the same instant can both pass; that race is not
// worth a lock on a hand-run action.
export async function POST(
  req: AuthenticatedMedusaRequest<Body>,
  res: MedusaResponse,
): Promise<void> {
  const verified = req.body?.verified;
  const reason = req.body?.reason;
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
    const accounts = parseSavedBankAccounts(customer.metadata?.bank_accounts);
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
    const others = [...new Set(holders.flat().map((h) => h.customer_id))];
    const alreadyVerified =
      others.length === 0
        ? undefined
        : (
            await customers.listCustomers(
              { id: others },
              { select: ['id', 'metadata'], take: others.length },
            )
          ).find((c) => bankShareVerified(c.metadata ?? {}));
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
    verified,
    reason: reason.trim(),
  });
  res.json({ verified });
}

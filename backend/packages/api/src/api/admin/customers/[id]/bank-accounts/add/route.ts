import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError, Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../../../../modules/packs';
import {
  findBank,
  sandboxOnlyBank,
} from '../../../../../../modules/packs/banks';
import { resolveActiveGateway } from '../../../../../../modules/packs/gateway';
import { withdrawalDetailsError } from '../../../../../../modules/packs/gateway-withdrawal';
import { sendSavedAccountAddedNotice } from '../../../../../../modules/packs/saved-account-notice';
import {
  BANNED_PAYOUT_ACCOUNT_MESSAGE,
  HOLDER_NAME_INVALID_MESSAGE,
  heldByAnother,
  holderNameInvalid,
  normalizeHolderName,
  newSavedBankAccount,
  verifiedElsewhere,
} from '../../../../../../modules/packs/saved-accounts';
import type PacksModuleService from '../../../../../../modules/packs/service';

type Body = {
  bank_code?: unknown;
  account_number?: unknown;
  account_holder_name?: unknown;
  reason?: unknown;
};

// POST /admin/customers/:id/bank-accounts/add — support saves a bank account for
// a player with none (ADR 0015). The override for a customer save refused because
// another account holds the number, which paid-out rows make permanent. Support
// vouches for a shared number by adding it, so it arrives verified, unless another
// account already is. Same checks as a customer save otherwise, cooling-off and
// the owner's notice included.
export async function POST(
  req: AuthenticatedMedusaRequest<Body>,
  res: MedusaResponse,
): Promise<void> {
  const body = req.body ?? {};
  const reason = body.reason;
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
  const invalid = withdrawalDetailsError({
    bankCode: body.bank_code,
    accountNumber: body.account_number,
    accountHolderName: body.account_holder_name,
  });
  if (invalid) throw new MedusaError(MedusaError.Types.INVALID_DATA, invalid);
  const bank = findBank(body.bank_code as string);
  if (
    !bank ||
    sandboxOnlyBank(bank.id, process.env, await resolveActiveGateway(req.scope))
  ) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'Pick a bank from the list.',
    );
  }
  const account = newSavedBankAccount(
    bank,
    body.account_number as string,
    normalizeHolderName((body.account_holder_name as string | undefined) ?? ''),
  );
  // Stored and compared as a customer save stores it, so the one-name rule sees
  // support's entries too.
  if (!bank.wallet && holderNameInvalid(account.accountHolderName)) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      HOLDER_NAME_INVALID_MESSAGE,
    );
  }

  const customerId = req.params.id;
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  // A banned number stays banned, support's add included (owner, 2026-11-03).
  if (
    await packs.payoutAccountBanned(
      account.accountNumber,
      bank.wallet !== undefined,
    )
  ) {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      BANNED_PAYOUT_ACCOUNT_MESSAGE,
    );
  }
  const holders = (
    await packs.otherPayoutAccountHolders(
      customerId,
      account.accountNumber,
      bank.wallet !== undefined,
    )
  ).filter((h) => heldByAnother([h], account.bankCode));
  const others = [...new Set(holders.map((h) => h.customer_id))];
  if (others.length > 0) {
    const customers = req.scope.resolve(Modules.CUSTOMER);
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

  await packs.addSavedBankAccount({
    customerId,
    adminId: req.auth_context.actor_id,
    account,
    verify: others.length > 0,
    reason: reason.trim(),
  });
  // A new payout destination is a security event whoever adds it. After commit,
  // and it never fails the add (the helper swallows its own errors).
  await sendSavedAccountAddedNotice(req.scope, {
    customerId,
    accountId: account.id,
    bankName: account.bankName,
    accountNumber: account.accountNumber,
    savedAt: account.savedAt as string,
  });
  res.json({ added: true });
}

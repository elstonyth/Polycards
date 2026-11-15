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
  holderNameInvalid,
  normalizeHolderName,
  newSavedBankAccount,
} from '../../../../../../modules/packs/saved-accounts';
import type PacksModuleService from '../../../../../../modules/packs/service';

type Body = {
  bank_code?: unknown;
  account_number?: unknown;
  account_holder_name?: unknown;
  reason?: unknown;
};

// POST /admin/customers/:id/bank-accounts/add — support saves a bank account in
// a free slot (ADR 0015). The override for a customer save refused because
// another account holds the number, which paid-out rows make permanent. Support
// vouches for a shared number by adding it, so it arrives verified, unless another
// account already is. It is also the way past the one-name-on-every-bank rule
// for a name two banks spell differently, so that rule is not checked here. Nor
// is a holder name another account used (a customer save's name-linked rule):
// support adds for a person it checked (decision 2026-11-15: kept as it is).
// The ban list, cooling-off and the owner's notice apply as to a customer save.
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
  // Every spelling: a PayNow mobile is one number with or without its 65.
  const number = await packs.payoutNumberStanding(customerId, {
    bankCode: account.bankCode,
    accountNumber: account.accountNumber,
  });
  // A banned number stays banned, support's add included (owner, 2026-11-03).
  if (number.bannedForPlayer) {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      BANNED_PAYOUT_ACCOUNT_MESSAGE,
    );
  }
  const verifiedId = number.holders.find((h) => h.verified)?.customerId;
  if (verifiedId) {
    const [other] = await req.scope
      .resolve(Modules.CUSTOMER)
      .listCustomers(
        { id: [verifiedId] },
        { select: ['id', 'metadata'], take: 1 },
      );
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      `One person, one account: ${other?.metadata?.handle ?? verifiedId} is already verified on this bank account. Undo that first if this is the right account.`,
    );
  }

  await packs.addSavedBankAccount({
    customerId,
    adminId: req.auth_context.actor_id,
    account,
    verify: number.holders.length > 0,
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

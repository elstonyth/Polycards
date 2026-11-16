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
  newSavedBankAccount,
  realNameHolder,
} from '../../../../../../modules/packs/saved-accounts';
import type PacksModuleService from '../../../../../../modules/packs/service';

// An older admin page may still send account_holder_name: never read.
type Body = {
  bank_code?: unknown;
  account_number?: unknown;
  reason?: unknown;
};

// POST /admin/customers/:id/bank-accounts/add — support saves a bank account in
// a free slot (ADR 0015). The override for a customer save refused because
// another account holds the number, which paid-out rows make permanent. Support
// vouches for a shared number by adding it, so it arrives verified, unless another
// account already is.
//
// One name per account (owner, 2026-11-16): the bank's holder is the player's
// real name, never typed, with no override. To fix a spelling, support corrects
// the real name first (adminSetRealName carries it to the saved banks). No real
// name, or one not in English letters, and nothing is added. The one-name-on-
// every-bank rule is not checked: the new bank carries the real name, and an
// older bank in another name is for support and the owner to review. Nor is a
// name another account used (a customer save's name-linked rule): support adds
// for a person it checked (decision 2026-11-15: kept as it is). The ban list,
// cooling-off and the owner's notice apply as to a customer save.
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
  const customerId = req.params.id;
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const picked =
    typeof body.bank_code === 'string' ? findBank(body.bank_code) : undefined;
  let holderName = '';
  if (picked && !picked.wallet) {
    const { realName } = await packs.getVerificationState(customerId);
    const holder = realNameHolder(realName);
    if (!holder) {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        realName?.trim()
          ? "This player's real name is not in English letters, so a bank account cannot carry it. Correct the real name first."
          : 'This player has no real name on file. A bank account is saved in the real name: set it first.',
      );
    }
    holderName = holder;
  }
  const invalid = withdrawalDetailsError({
    bankCode: body.bank_code,
    accountNumber: body.account_number,
    accountHolderName: holderName,
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
  // Stored as a customer save stores it, so the one-name rule sees support's
  // entries too.
  const account = newSavedBankAccount(
    bank,
    body.account_number as string,
    holderName,
  );

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

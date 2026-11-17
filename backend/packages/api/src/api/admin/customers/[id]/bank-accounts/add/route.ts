import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { savePayoutDestination } from '../../../../../../modules/packs/payout-destination-save';

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
  // The real name, the ban list, the verified-elsewhere refusal, the lock, the
  // re-check and the owner's notice are the save's (payout-destination-save.ts).
  await savePayoutDestination(req.scope, {
    customerId: req.params.id,
    actor: {
      kind: 'support',
      adminId: req.auth_context.actor_id,
      reason: reason.trim(),
    },
    bankCode: body.bank_code,
    accountNumber: body.account_number,
  });
  res.json({ added: true });
}

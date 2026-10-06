import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError, Modules } from '@medusajs/framework/utils';
import type { ICustomerModuleService } from '@medusajs/framework/types';
import { PACKS_MODULE } from '../../../../../modules/packs';
import type PacksModuleService from '../../../../../modules/packs/service';
import { E164_RE } from '../../../../../utils/phone-verification';
import { assertPhoneUnclaimed } from '../../../../utils/phone-claim';
import { sendPhoneChangedNotice } from '../../../../utils/phone-changed-notice';

// `new_phone`, not `phone`: rejectAdminPhoneWrite rides the
// '/admin/customers/*' POST matcher (middlewares.ts), whose wildcard also
// covers this sub-path, and refuses any body carrying a `phone` key. That guard
// protects the GENERIC admin customer routes and must stay as it is.
type Body = { new_phone?: unknown; reason?: unknown };

// POST /admin/customers/:id/phone — customer service moves a player's phone
// (spec 2026-10-06). Once verified, the customer can no longer change it
// themselves (store/phone-verification/change refuses), so this is the one way
// a lost or replaced number gets updated. It is the "purpose-built, audited
// route that goes through assertPhoneUnclaimed" rejectAdminPhoneWrite's
// docblock asks for:
//   - one phone = one account still holds (assertPhoneUnclaimed);
//   - only a real account (has_account) — a guest row holding a phone is
//     invisible to that check (see phone-claim.ts);
//   - the move is audited with a mandatory reason (BEFORE the write — see
//     below), and the account is stamped verified (the agent vouches);
//   - the account's EMAIL is told, because a socially engineered change here
//     leads straight to the phone password reset — the same reason the
//     customer-side change emails.
export async function POST(
  req: AuthenticatedMedusaRequest<Body>,
  res: MedusaResponse,
): Promise<void> {
  const customerId = req.params.id;
  const adminId = req.auth_context.actor_id;
  const reason = req.body?.reason;
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
  const phone = req.body?.new_phone;
  if (typeof phone !== 'string' || !E164_RE.test(phone)) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'Enter the number in international format, e.g. +60123456789.',
    );
  }

  const customers = req.scope.resolve<ICustomerModuleService>(Modules.CUSTOMER);
  const current = await customers.retrieveCustomer(customerId, {
    select: ['id', 'email', 'phone', 'has_account'],
  });
  if (!current.has_account) {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      'This customer has no account login; a phone cannot be set on it.',
    );
  }
  await assertPhoneUnclaimed(req.scope, phone, customerId);

  const before =
    typeof current.phone === 'string' && current.phone !== ''
      ? current.phone
      : null;
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  // AUDIT FIRST. The number lives on the customer module's row, which no
  // packs transaction can reach, so the two writes cannot be atomic. Of the
  // two failure orders, a recorded attempt whose write then failed is the
  // safe one: a number moved with NO trail is exactly what this audit exists
  // to prevent (a socially engineered move is a takeover path). A retry after
  // a failed write records the attempt again, which is honest.
  await packs.recordAdminPhoneChange({
    customerId,
    adminId,
    before,
    after: phone,
    reason: reason.trim(),
  });
  await customers.updateCustomers(customerId, { phone });
  // The agent vouches for the number: stamp it verified (first-write-wins, so
  // an already-verified account keeps its original stamp). After the write —
  // never a stamp on a number that did not land.
  await packs.markPhoneVerified(customerId);

  if (before !== phone && typeof current.email === 'string' && current.email) {
    await sendPhoneChangedNotice(req.scope, {
      to: current.email,
      customerId,
      oldPhone: before,
      newPhone: phone,
      logTag: 'admin-phone-change',
    });
  }

  res.json({ customer: { id: customerId, phone } });
}

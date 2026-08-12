import type { AuthenticatedMedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../../../modules/packs';
import type PacksModuleService from '../../../../../modules/packs/service';

type Body = {
  bank_name?: unknown;
  bank_account_number?: unknown;
  account_holder_name?: unknown;
};

type Details = {
  bank_name: string;
  bank_account_number: string;
  account_holder_name: string | null;
};

// Digits, spaces and hyphens only — the formats banks actually print. Applied
// to the TRIMMED value, so a whitespace-only number can't slip past the regex.
const ACCOUNT_NUMBER = /^(?=.*[0-9])[0-9 -]+$/;

// GET /admin/customers/:id/payout-details — the manual-cashout bank destination
// (POLYCARD-BACK §4.3). Admin-only by the framework's /admin auth guard; these
// fields are deliberately absent from every /store route.
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const [row] = await packs.listPlayerPayoutDetails(
    { customer_id: req.params.id },
    { take: 1 },
  );
  const details: Details | null = row
    ? {
        bank_name: row.bank_name,
        bank_account_number: row.bank_account_number,
        account_holder_name: row.account_holder_name,
      }
    : null;

  // This response carries the FULL account number, which every list view masks.
  // The write twin audits; without this the read left no trace, so enumerating
  // customer ids harvested the whole table invisibly. Audit only a real reveal
  // — a miss (no row) exposes nothing.
  //
  // Best-effort: an audit failure must not deny an operator data they are
  // entitled to, and the throttle (now covering GET) is the volume control.
  if (row) {
    const digits = (row.bank_account_number ?? '').replace(/\D/g, '');
    try {
      await packs.createAdminActionAudits([
        {
          admin_id: req.auth_context.actor_id,
          entity_type: 'customer',
          entity_id: req.params.id,
          action: 'reveal',
          before: null,
          // Same last-4 rule as the write path: the audit feed must never carry
          // the full number it exists to record the disclosure of.
          after: {
            bank_name: row.bank_name,
            account_last4: digits.length > 4 ? digits.slice(-4) : null,
          },
          reason: 'payout details revealed',
        },
      ]);
    } catch {
      // Never fail the read on an audit write.
    }
  }

  res.json({ details });
}

// POST same path — upsert (one row per customer) + audit row, one transaction.
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const body = (req.body ?? {}) as Body;
  const bankName = typeof body.bank_name === 'string' ? body.bank_name.trim() : '';
  if (bankName === '' || bankName.length > 100) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'bank_name is required (1–100 chars).',
    );
  }
  const accountNumber =
    typeof body.bank_account_number === 'string'
      ? body.bank_account_number.trim()
      : '';
  if (
    accountNumber === '' ||
    accountNumber.length > 34 ||
    !ACCOUNT_NUMBER.test(accountNumber)
  ) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'bank_account_number must be 1–34 chars of digits, spaces or hyphens, with at least one digit.',
    );
  }
  // Optional: absent, non-string or blank all normalize to null (one stored
  // shape for "not provided" instead of null-vs-'' at every read site).
  const holderRaw =
    typeof body.account_holder_name === 'string'
      ? body.account_holder_name.trim()
      : '';
  if (holderRaw.length > 100) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'account_holder_name must be 100 chars or fewer.',
    );
  }

  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const details = await packs.setPayoutDetails({
    customerId: req.params.id,
    adminId: req.auth_context.actor_id,
    bankName,
    bankAccountNumber: accountNumber,
    accountHolderName: holderRaw === '' ? null : holderRaw,
  });
  res.json({ details });
}

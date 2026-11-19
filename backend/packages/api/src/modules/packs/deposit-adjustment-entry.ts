import { MedusaError } from '@medusajs/framework/utils';
import { resolvePacks, type GatewayDeposits } from './facets';
import { getDepositDetail, rowGatewayConfigs } from './gateway';
import { stampNote } from './gateway-audit';
import { classifyRequeryError } from './gateway-reconcile';
import { toOptionalMoney } from './money';
import { rowFx } from './payment-fx';

/** What a gateway merchant reference may look like: GlobePay365's manual
 *  entries read MD20261108102020, our own orders PC-<hex>. */
const REF_PATTERN = /^[A-Za-z0-9_-]{4,64}$/;

type Packs = Pick<
  GatewayDeposits,
  'listGatewayDeposits' | 'updateGatewayDeposits' | 'createAdminActionAudits'
>;

export type LinkAdjustmentEntryResult = {
  linked: true;
  ref: string;
  /** The gateway's own id for the entry (GlobePay365: D…). */
  entryId: string | null;
};

/**
 * Settlement's Link gateway entry. A short payment credited by hand for what
 * arrived leaves the order FAILED at the gateway, which will not approve a
 * different amount; it books the arrived sum as its own manual entry instead.
 * Linking that entry's merchant reference to the row lets the hourly audit
 * check the credit against it (adjustmentAuditNote) rather than flag the row
 * for ever.
 *
 * Moves no money. It can silence a warning, so it is only as good as its
 * checks: settled rows whose own order the gateway reports FAILED right now
 * (the only finding an entry answers), one link per row, never a reference any deposit
 * row already holds (a real customer order attached here would hide a credit
 * nothing paid for), and the gateway asked NOW, which must report the entry
 * paid for exactly what the row credited, through the row's own FX lock.
 * Audited with the gateway's answer.
 */
export async function linkAdjustmentEntry(
  scope: { resolve: <T>(key: string) => T },
  input: { depositId: string; ref: string; adminId: string; reason: string },
): Promise<LinkAdjustmentEntryResult> {
  const refused = (message: string) =>
    new MedusaError(MedusaError.Types.NOT_ALLOWED, message);
  const ref = input.ref.trim();
  if (!REF_PATTERN.test(ref)) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "Enter the gateway entry's merchant reference: 4 to 64 letters, digits, - or _.",
    );
  }
  const reason = input.reason.trim();
  if (!reason || reason.length > 500) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'A reason (up to 500 characters) is required.',
    );
  }

  const packs = resolvePacks<Packs>(scope);
  const [row] = await packs.listGatewayDeposits(
    { id: input.depositId },
    { take: 1 },
  );
  if (!row) {
    throw new MedusaError(MedusaError.Types.NOT_FOUND, 'No such deposit.');
  }
  if (row.status !== 'settled') {
    throw refused(
      'Only a settled deposit can be linked to a gateway entry. Nothing was changed.',
    );
  }
  if (row.gateway_adjustment_ref) {
    throw refused(
      `This deposit is already linked to gateway entry ${row.gateway_adjustment_ref}. Nothing was changed.`,
    );
  }
  if (
    ref === row.merchant_transaction_id ||
    ref === row.gateway_transaction_id
  ) {
    throw refused(
      "That is this deposit's own order reference, not the gateway's entry for what arrived. Nothing was changed.",
    );
  }
  for (const column of [
    'merchant_transaction_id',
    'gateway_transaction_id',
    'gateway_adjustment_ref',
  ] as const) {
    const [holder] = await packs.listGatewayDeposits(
      { [column]: ref } as never,
      { take: 1 },
    );
    if (holder && holder.id !== row.id) {
      throw refused(
        'That reference belongs to another deposit. One gateway entry can back only one credit. Nothing was changed.',
      );
    }
  }

  const config = rowGatewayConfigs()(row.gateway);
  if (!config) {
    throw refused(
      `Gateway "${row.gateway}" is not configured here, so it cannot confirm the entry. Nothing was changed.`,
    );
  }
  // The order itself must still be FAILED at the gateway: that is the one case
  // the audit checks the entry in place of the order (gateway-audit job). Any
  // other answer is a different finding, and a link must never clear it.
  let order: Awaited<ReturnType<typeof getDepositDetail>>;
  try {
    order = await getDepositDetail(
      row.merchant_transaction_id,
      config,
      rowFx(row),
      row.gateway_transaction_id,
    );
  } catch {
    throw refused(
      "The gateway could not confirm this deposit's own order is failed. Only a short payment the gateway kept failed can be linked. Nothing was changed.",
    );
  }
  if (order.state !== 'failed') {
    throw refused(
      `The gateway reports this deposit's own order as ${order.state}, not failed. Only a short payment the gateway kept failed can be linked. Nothing was changed.`,
    );
  }
  let entry: Awaited<ReturnType<typeof getDepositDetail>>;
  try {
    entry = await getDepositDetail(ref, config, rowFx(row));
  } catch (error) {
    throw refused(
      classifyRequeryError(error).kind === 'not-found'
        ? 'The gateway has no entry with that reference. Check it is the Merchant Reference ID of the manual entry. Nothing was changed.'
        : 'The gateway could not be asked about that entry. Nothing was changed. Try again in a moment.',
    );
  }
  if (entry.state !== 'success') {
    throw refused(
      `The gateway reports that entry as ${entry.state}, not paid. Nothing was changed.`,
    );
  }
  const credited = toOptionalMoney(row.amount_settled);
  const amount = Number(entry.amount);
  if (
    credited === null ||
    !Number.isFinite(amount) ||
    Math.abs(credited - amount) >= 0.005
  ) {
    throw refused(
      `The gateway's entry converts to RM ${Number.isFinite(amount) ? amount.toFixed(2) : '?'}, but this deposit credited RM ${credited === null ? '?' : credited.toFixed(2)}. Nothing was changed. Ask an engineer to look at it.`,
    );
  }

  // The partial unique index is the last word on "one entry, one row": a
  // concurrent link of the same reference fails here, after every check.
  try {
    await packs.updateGatewayDeposits({
      id: row.id,
      gateway_adjustment_ref: ref,
      // The audit would clear it at the next run; a settled row should not
      // read "investigate" for an hour after the operator answered it.
      ...stampNote(row, null),
    });
  } catch (error) {
    if (/unique|duplicate/i.test(error instanceof Error ? error.message : '')) {
      throw refused(
        'That reference belongs to another deposit. One gateway entry can back only one credit. Nothing was changed.',
      );
    }
    throw error;
  }
  await packs.createAdminActionAudits([
    {
      admin_id: input.adminId,
      entity_type: 'gateway_deposit',
      entity_id: row.id,
      action: 'edit',
      before: { gateway_adjustment_ref: null },
      after: {
        gateway_adjustment_ref: ref,
        gateway_entry_id: entry.transactionId ?? null,
        entry_amount: amount,
        entry_reported_amount: entry.reportedAmount,
      },
      reason,
    },
  ]);
  return { linked: true, ref, entryId: entry.transactionId ?? null };
}

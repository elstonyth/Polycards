import { MedusaError } from '@medusajs/framework/utils';
import { resolvePacks, type GatewayDeposits } from './facets';
import { getDepositDetail, rowGatewayConfigs } from './gateway';
import { stampNote } from './gateway-audit';
import { classifyRequeryError } from './gateway-reconcile';
import { toOptionalMoney } from './money';
import { rowFx } from './payment-fx';
import type { LinkAdjustmentEntryResult } from '../../api/admin/payments/deposits/[id]/adjustment-entry/types';

/** What a gateway merchant reference may look like: GlobePay365's manual
 *  entries read MD20261108102020, our own orders PC-<hex>. */
const REF_PATTERN = /^[A-Za-z0-9_-]{4,64}$/;

type Packs = Pick<
  GatewayDeposits,
  'claimDepositAdjustmentRef' | 'listCreditTransactions' | 'listGatewayDeposits'
>;

/**
 * Whether a hand credit (adjustment or bonus grant, the pair ledgerTrail reads)
 * to a DIFFERENT customer already quotes the entry's reference. The gateway's
 * answer names no payer, so the ledger is the only other witness to whose
 * money an entry is (code review, 2026-11-20). Case-insensitive, with "_"
 * escaped so it matches itself and not any character.
 */
export async function quotedForAnotherCustomer(
  packs: Pick<GatewayDeposits, 'listCreditTransactions'>,
  input: { customerId: string; ref: string },
): Promise<boolean> {
  const [quoted] = await packs.listCreditTransactions(
    {
      customer_id: { $ne: input.customerId },
      reason: ['adjustment', 'bonus_grant'],
      reference: { $ilike: `%${input.ref.replace(/_/g, '\\_')}%` },
    } as never,
    { take: 1, select: ['id'] },
  );
  return Boolean(quoted);
}

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
 * (the only finding an entry answers); one link per row, replaced only when
 * the gateway no longer backs the linked entry (not paid, or paid for another
 * sum, or gone); never a reference any deposit row already holds (a real
 * customer order attached here would hide a credit nothing paid for), nor an
 * entry whose gateway id another row holds, nor one a hand credit to another
 * customer quotes; and the gateway asked NOW, which
 * must report the entry paid for exactly what the row credited, through the
 * row's own FX lock. The write is a compare-and-set on the link this call
 * read, so two operators cannot both win. Audited with the gateway's answer,
 * in the same transaction as the write.
 *
 * What it cannot check: the gateway names no payer, so an entry booked for
 * someone else that no row and no hand credit quotes still passes.
 */
export async function linkAdjustmentEntry(
  scope: { resolve: <T>(key: string) => T },
  input: { depositId: string; ref: string; adminId: string; reason: string },
): Promise<LinkAdjustmentEntryResult> {
  const refused = (message: string) =>
    new MedusaError(MedusaError.Types.NOT_ALLOWED, message);
  const TAKEN =
    'That reference belongs to another deposit. One gateway entry can back only one credit. Nothing was changed.';
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
  const linkedRef = row.gateway_adjustment_ref ?? null;
  if (linkedRef === ref) {
    throw refused(
      `This deposit is already linked to gateway entry ${ref}. Nothing was changed.`,
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
      throw refused(TAKEN);
    }
  }

  if (
    await quotedForAnotherCustomer(packs, { customerId: row.customer_id, ref })
  ) {
    throw refused(
      'That reference is quoted by a hand credit to another customer, so the entry already backs their credit. Nothing was changed.',
    );
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
  const credited = toOptionalMoney(row.amount_settled);
  const backs = (answer: Awaited<ReturnType<typeof getDepositDetail>>) => {
    const amount = Number(answer.amount);
    return (
      answer.state === 'success' &&
      credited !== null &&
      Number.isFinite(amount) &&
      Math.abs(credited - amount) < 0.005
    );
  };
  // One link per row, but a link the gateway stopped backing gives way, so
  // correcting it needs no database edit (code review, 2026-11-20). One the
  // gateway still backs, or cannot be asked about, stays.
  if (linkedRef) {
    let old: Awaited<ReturnType<typeof getDepositDetail>> | null;
    try {
      old = await getDepositDetail(linkedRef, config, rowFx(row));
    } catch (error) {
      if (classifyRequeryError(error).kind !== 'not-found') {
        throw refused(
          `The gateway could not be asked about entry ${linkedRef}, which this deposit is linked to now. Nothing was changed. Try again in a moment.`,
        );
      }
      old = null;
    }
    if (old && backs(old)) {
      throw refused(
        `This deposit is already linked to gateway entry ${linkedRef}, and the gateway still reports it paid for what the deposit credited. Nothing was changed.`,
      );
    }
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

  // The checks above compare the TYPED text, and REF_PATTERN takes either
  // letter case. A gateway that looks references up regardless of case would
  // answer "md…" with the entry "MD…" another row holds, or with a customer's
  // own paid order (review, 2026-11-21). The gateway's OWN id for what it
  // answered does not depend on how the reference was typed, so "one entry,
  // one row" is keyed on that too: no other row may hold it as its order's
  // gateway id or as a linked entry's. take 2: the row itself may match.
  // (Every adapter echoes the asked reference back as merchantTransactionId,
  // so there is no gateway-side reference to compare the typed one with.)
  const entryId = entry.transactionId?.trim() || null;
  if (entryId) {
    for (const column of [
      'gateway_transaction_id',
      'gateway_adjustment_entry_id',
    ] as const) {
      const holders = await packs.listGatewayDeposits(
        { [column]: entryId } as never,
        { take: 2 },
      );
      if (holders.some((holder) => holder.id !== row.id)) {
        throw refused(TAKEN);
      }
    }
  }

  // The partial unique indexes (reference and entry id) are the last word on
  // "one entry, one row": a concurrent link of the same entry fails here,
  // after every check. The write moves the row only from the link read above,
  // so a second operator who linked it meanwhile is not silently overwritten.
  // The audit row is inserted in the claim's own transaction, only when the
  // claim was won, so a link is never left without its log entry, nor a
  // replaced reference recorded nowhere (review, 2026-11-21).
  let claimed: boolean;
  try {
    claimed = await packs.claimDepositAdjustmentRef({
      id: row.id,
      from: linkedRef,
      to: ref,
      entryId,
      // The audit would clear it at the next run; a settled row should not
      // read "investigate" for an hour after the operator answered it.
      set: stampNote(row, null),
      audit: {
        admin_id: input.adminId,
        entity_type: 'gateway_deposit',
        entity_id: row.id,
        action: 'edit',
        before: { gateway_adjustment_ref: linkedRef },
        after: {
          gateway_adjustment_ref: ref,
          gateway_entry_id: entryId,
          entry_amount: amount,
          entry_reported_amount: entry.reportedAmount,
        },
        reason,
      },
    });
  } catch (error) {
    // Medusa's dbErrorMapper rewrites Postgres's "duplicate key … unique
    // constraint" into "Gateway deposit with gateway_adjustment_ref: …, already
    // exists." (the integration spec pins it, for both indexed columns), so
    // match both wordings.
    if (
      /unique|duplicate|already exists/i.test(
        error instanceof Error ? error.message : '',
      )
    ) {
      throw refused(TAKEN);
    }
    throw error;
  }
  if (!claimed) {
    throw refused(
      'This deposit changed while the gateway was being asked, most likely linked by someone else. Nothing was changed. Reload and check it.',
    );
  }
  return { linked: true, ref, entryId };
}

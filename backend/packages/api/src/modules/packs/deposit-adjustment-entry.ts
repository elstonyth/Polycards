import { MedusaError } from '@medusajs/framework/utils';
import { resolvePacks, type GatewayDeposits } from './facets';
import {
  getDepositDetail,
  rowGatewayConfigs,
  type GatewayConfig,
} from './gateway';
import { stampNote } from './gateway-audit';
import { applyDepositOutcome } from './gateway-deposit';
import { classifyRequeryError } from './gateway-reconcile';
import { toOptionalMoney } from './money';
import { rowFx } from './payment-fx';
import { topupIdempotencyReference } from './topup';
import type { LinkAdjustmentEntryResult } from '../../api/admin/payments/deposits/[id]/adjustment-entry/types';
import type { CreditFromEntryResult } from '../../api/admin/payments/deposits/[id]/credit-from-entry/types';

/** What a gateway merchant reference may look like: GlobePay365's manual
 *  entries read MD20261108102020, our own orders PC-<hex>. */
const REF_PATTERN = /^[A-Za-z0-9_-]{4,64}$/;

const TAKEN =
  'That reference belongs to another deposit. One gateway entry can back only one credit. Nothing was changed.';

type Packs = Pick<
  GatewayDeposits,
  'claimDepositAdjustmentRef' | 'listCreditTransactions' | 'listGatewayDeposits'
>;

type Row = Awaited<ReturnType<GatewayDeposits['listGatewayDeposits']>>[number];

type Detail = Awaited<ReturnType<typeof getDepositDetail>>;

const refused = (message: string) =>
  new MedusaError(MedusaError.Types.NOT_ALLOWED, message);

/**
 * Whether a hand credit (adjustment or bonus grant, the pair ledgerTrail reads)
 * to a DIFFERENT customer already quotes the entry's reference. The gateway's
 * answer names no payer, so the ledger is the only other witness to whose
 * money an entry is (code review, 2026-11-20). Case-insensitive, with the LIKE
 * metacharacters (%, _ and the escape character \) escaped so each matches
 * itself, the same way the admin assistant's search does.
 */
export async function quotedForAnotherCustomer(
  packs: Pick<GatewayDeposits, 'listCreditTransactions'>,
  input: { customerId: string; ref: string },
): Promise<boolean> {
  const [quoted] = await packs.listCreditTransactions(
    {
      customer_id: { $ne: input.customerId },
      reason: ['adjustment', 'bonus_grant'],
      reference: { $ilike: `%${input.ref.replace(/[%_\\]/g, '\\$&')}%` },
    } as never,
    { take: 1, select: ['id'] },
  );
  return Boolean(quoted);
}

/** The typed reference and reason, trimmed, or an INVALID_DATA refusal. */
function readInput(input: { ref: string; reason: string }) {
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
  return { ref, reason };
}

async function readRow(packs: Packs, depositId: string): Promise<Row> {
  const [row] = await packs.listGatewayDeposits({ id: depositId }, { take: 1 });
  if (!row) {
    throw new MedusaError(MedusaError.Types.NOT_FOUND, 'No such deposit.');
  }
  return row;
}

/**
 * The checks on the typed reference that need no gateway: not the row's own
 * order, held by no other deposit row in any column, and quoted by no hand
 * credit to another customer.
 */
async function assertRefFree(packs: Packs, row: Row, ref: string) {
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
}

function configFor(row: Row): GatewayConfig {
  const config = rowGatewayConfigs()(row.gateway);
  if (!config) {
    throw refused(
      `Gateway "${row.gateway}" is not configured here, so it cannot confirm the entry. Nothing was changed.`,
    );
  }
  return config;
}

/** The gateway's answer for the entry, asked now, through the row's FX lock.
 *  Refused unless the gateway reports it paid. */
async function askPaidEntry(
  ref: string,
  row: Row,
  config: GatewayConfig,
): Promise<Detail> {
  let entry: Detail;
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
  return entry;
}

/**
 * The checks above compare the TYPED text, and REF_PATTERN takes either
 * letter case. A gateway that looks references up regardless of case would
 * answer "md…" with the entry "MD…" another row holds, or with a customer's
 * own paid order (review, 2026-11-21). The gateway's OWN id for what it
 * answered does not depend on how the reference was typed, so "one entry,
 * one row" is keyed on that too: no other row may hold it as its order's
 * gateway id or as a linked entry's. take 2: the row itself may match.
 * (Every adapter echoes the asked reference back as merchantTransactionId,
 * so there is no gateway-side reference to compare the typed one with.)
 */
async function entryIdFree(
  packs: Packs,
  row: Row,
  entry: Detail,
): Promise<string | null> {
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
  return entryId;
}

/** Medusa's dbErrorMapper rewrites Postgres's "duplicate key … unique
 *  constraint" into "Gateway deposit with gateway_adjustment_ref: …, already
 *  exists." (the integration spec pins it, for both indexed columns), so
 *  match both wordings. */
const isUniqueClash = (error: unknown) =>
  /unique|duplicate|already exists/i.test(
    error instanceof Error ? error.message : '',
  );

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
  const { ref, reason } = readInput(input);
  const packs = resolvePacks<Packs>(scope);
  const row = await readRow(packs, input.depositId);
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
  await assertRefFree(packs, row, ref);
  const config = configFor(row);
  // The order itself must still be FAILED at the gateway: that is the one case
  // the audit checks the entry in place of the order (gateway-audit job). Any
  // other answer is a different finding, and a link must never clear it.
  let order: Detail;
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
  const backs = (answer: Detail) => {
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
    let old: Detail | null;
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
  const entry = await askPaidEntry(ref, row, config);
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
  const entryId = await entryIdFree(packs, row, entry);

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
    if (isUniqueClash(error)) throw refused(TAKEN);
    throw error;
  }
  if (!claimed) {
    throw refused(
      'This deposit changed while the gateway was being asked, most likely linked by someone else. Nothing was changed. Reload and check it.',
    );
  }
  return { linked: true, ref, entryId };
}

/** The gateways that book what arrived as their own manual entry, which this
 *  action reads. GlobePay365 only (`fake` exists under NODE_ENV=test alone).
 *  Another gateway's lookup by reference could return some other paid record
 *  no row holds, bounded only by the band (code review, 2026-11-21). */
const ENTRY_GATEWAYS: ReadonlySet<string> = new Set(['gp365', 'fake']);

/** How far what arrived may sit from what was ordered: 80% to 105% of the
 *  order. Every case seen to 2026-11-21 fits (16 ordered, 14 arrived is the
 *  lowest at 87.5%; 75 ordered, 75.36 arrived the highest). The gateway names
 *  no payer, so this bounds what a wrong entry pasted on a small row could
 *  credit. Wider gaps stay an engineer's call. */
export const ENTRY_BAND = { minPercent: 80, maxPercent: 105 } as const;

/** Compared in the GATEWAY's currency when the row has one (the USDT the
 *  customer was asked for against the USDT that arrived), so the edges are
 *  exact: the RM figure is already floored to the cent and can sit a cent
 *  under 80% when the USDT is exactly 80% (code review, 2026-11-21). In
 *  ten-thousandths, integers on both sides. */
function withinBand(arrived: number, ordered: number): boolean {
  const got = Math.round(arrived * 10_000) * 100;
  const asked = Math.round(ordered * 10_000);
  return (
    got >= asked * ENTRY_BAND.minPercent && got <= asked * ENTRY_BAND.maxPercent
  );
}

const UNSETTLED_ROW = ['failed', 'expired'];

/**
 * Deposits' Credit from gateway entry. A USDT payment arrived as a different
 * sum than the order: GlobePay365 kept the order FAILED (Verify Fail), our row
 * expired or failed, and GlobePay365 booked what arrived as its own manual
 * entry. The owner's rule is to credit what arrived, at the row's FX lock.
 * This does that from the gateway's word alone, so staff need no engineer.
 *
 * Checks, all before money moves: a GlobePay365 row (ENTRY_GATEWAYS), failed
 * or expired (pending may still be paid by the sweep, settled is done); not
 * already reserved for a DIFFERENT entry (a retry must name the same one); the
 * typed reference is free (assertRefFree, as for a link); the gateway, asked
 * now, reports the row's own order failed (a paid order goes through Credit
 * deposit) and the entry paid; the entry inside ENTRY_BAND of the order; the
 * entry's gateway id free; and no hand credit to this customer already quoting
 * the entry (that would pay twice).
 *
 * Then: the entry is RESERVED on the row (the link claim: a compare-and-set
 * from "not linked", on an unsettled row only, under the partial unique
 * indexes), so two operators cannot spend one entry on two rows, and a credit
 * that landed meanwhile can never have its entry swapped. Then the credit runs
 * through applyDepositOutcome on the sweep's own anchor (source 'entry': the
 * ceiling, not the equality fence). The reservation is released when nothing
 * landed: the ledger refused, or it threw before the anchor held a credit. A
 * credit that landed keeps its entry, and a retry with the same reference
 * replays on the anchor. Audited after the credit, as Credit deposit is.
 *
 * What it cannot check, as for a link: the gateway names no payer.
 */
export async function creditFromAdjustmentEntry(
  scope: { resolve: <T>(key: string) => T },
  input: { depositId: string; ref: string; adminId: string; reason: string },
): Promise<CreditFromEntryResult> {
  const { ref, reason } = readInput(input);
  const packs = resolvePacks<
    Packs &
      Pick<GatewayDeposits, 'createAdminActionAudits' | 'updateGatewayDeposits'>
  >(scope);
  const row = await readRow(packs, input.depositId);
  if (!ENTRY_GATEWAYS.has(row.gateway ?? '')) {
    throw refused(
      'Only a GlobePay365 (USDT) top-up can be credited from a gateway entry. Nothing was credited.',
    );
  }
  if (row.status === 'settled') {
    throw refused('This deposit is already settled. Nothing was credited.');
  }
  if (!UNSETTLED_ROW.includes(row.status)) {
    throw refused(
      'This deposit is still waiting for the gateway, which may still pay it. Credit it from an entry once it has expired. Nothing was credited.',
    );
  }
  const linkedRef = row.gateway_adjustment_ref ?? null;
  if (linkedRef && linkedRef !== ref) {
    throw refused(
      `This deposit is already being credited from gateway entry ${linkedRef}. Retry with that reference, or ask an engineer if it is wrong. Nothing was credited.`,
    );
  }
  await assertRefFree(packs, row, ref);
  const config = configFor(row);

  let order: Detail;
  try {
    order = await getDepositDetail(
      row.merchant_transaction_id,
      config,
      rowFx(row),
      row.gateway_transaction_id,
    );
  } catch {
    throw refused(
      "The gateway could not confirm this deposit's own order is failed. Nothing was credited. Try again in a moment.",
    );
  }
  if (order.state === 'success') {
    throw refused(
      "The gateway reports this deposit's own order as paid. Use Credit deposit instead. Nothing was credited.",
    );
  }
  if (order.state !== 'failed') {
    throw refused(
      `The gateway reports this deposit's own order as ${order.state}, not failed. Only a payment the gateway kept failed can be credited from an entry. Nothing was credited.`,
    );
  }

  const entry = await askPaidEntry(ref, row, config);
  const amount = Number(entry.amount);
  const requested = Number(row.amount_requested);
  const orderedGateway = toOptionalMoney(row.gateway_amount);
  const [arrived, ordered] =
    orderedGateway !== null
      ? [Number(entry.reportedAmount), orderedGateway]
      : [amount, requested];
  if (
    !Number.isFinite(amount) ||
    amount <= 0 ||
    !Number.isFinite(arrived) ||
    !Number.isFinite(ordered) ||
    ordered <= 0
  ) {
    throw refused(
      "The gateway's entry amount could not be read. Nothing was credited. Ask an engineer to look at it.",
    );
  }
  if (!withinBand(arrived, ordered)) {
    throw refused(
      `The gateway's entry converts to RM ${amount.toFixed(2)}, too far from the order's RM ${requested.toFixed(2)} (${ENTRY_BAND.minPercent}% to ${ENTRY_BAND.maxPercent}% is allowed). Check the reference. Nothing was credited. Ask an engineer if it is right.`,
    );
  }
  const entryId = await entryIdFree(packs, row, entry);

  // A hand credit to THIS customer quoting the entry means staff already paid
  // it by adjustment (or a stray top-up names it); applyDepositOutcome's own
  // trail only looks for the order's references.
  const hand = await packs.listCreditTransactions(
    {
      customer_id: row.customer_id,
      reason: ['adjustment', 'bonus_grant', 'topup'],
    } as never,
    { select: ['reference'] },
  );
  const quoted = [ref, entryId]
    .filter((r): r is string => Boolean(r))
    .map((r) => r.toLowerCase());
  if (
    hand.some((c) => quoted.some((r) => c.reference?.toLowerCase().includes(r)))
  ) {
    throw refused(
      'A hand adjustment to this customer already names that entry. Crediting it would pay the customer twice. Nothing was credited.',
    );
  }

  // Reserved now unless a retry finds it already reserved for this same entry.
  let reservedNow = false;
  if (!linkedRef) {
    let reserved: boolean;
    try {
      reserved = await packs.claimDepositAdjustmentRef({
        id: row.id,
        from: null,
        to: ref,
        entryId,
        status: UNSETTLED_ROW,
      });
    } catch (error) {
      if (isUniqueClash(error)) throw refused(TAKEN);
      throw error;
    }
    if (!reserved) {
      throw refused(
        'This deposit changed while the gateway was being asked, most likely by someone else. Nothing was credited. Reload and check it.',
      );
    }
    reservedNow = true;
  }

  const anchor = topupIdempotencyReference(
    row.customer_id,
    row.merchant_transaction_id,
  );
  /** The credit on the anchor, if one landed: the ledger's own figure. */
  const anchored = async () => {
    const [credit] = await packs.listCreditTransactions(
      { customer_id: row.customer_id, source_transaction_id: anchor } as never,
      { take: 1 },
    );
    return credit ?? null;
  };
  // Gives the entry back only when THIS call reserved it, only from an
  // unsettled row, and never lets its own failure hide why it ran.
  const release = async () => {
    if (!reservedNow) return;
    try {
      await packs.claimDepositAdjustmentRef({
        id: row.id,
        from: ref,
        to: null,
        entryId: null,
        status: UNSETTLED_ROW,
      });
    } catch (error) {
      scope
        .resolve<{ error: (m: string) => void }>('logger')
        .error(
          `[payments] credit-from-entry: could not release entry ${ref} on deposit ${row.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
  };

  let outcome: Awaited<ReturnType<typeof applyDepositOutcome>>;
  try {
    outcome = await applyDepositOutcome(scope, row, {
      state: 'settled',
      source: 'entry',
      amount,
      gatewayRef: row.gateway_transaction_id || row.merchant_transaction_id,
      settledAt: new Date(),
    });
  } catch (error) {
    // A throw after the ledger write (the receipt, the row claim) leaves a
    // credit the entry belongs to. Unknown counts as landed: a stuck
    // reservation needs an engineer, a freed one could pay twice.
    const landed = await anchored().then(Boolean, () => true);
    if (!landed) await release();
    throw error;
  }
  if (!outcome.applied) {
    await release();
    throw refused(
      outcome.reason === 'hand-credited'
        ? 'A hand adjustment already names this deposit. Crediting it would pay the customer twice. Nothing was credited.'
        : `The gateway's entry converts to RM ${amount.toFixed(2)}, above what this gateway accepts. Nothing was credited. Ask an engineer to look at it.`,
    );
  }
  // A replay moved nothing: report what the ledger holds, not the entry.
  const ledger = outcome.replayed ? await anchored() : null;
  const credited = ledger ? Number(ledger.amount) : amount;

  await packs.createAdminActionAudits([
    {
      admin_id: input.adminId,
      entity_type: 'gateway_deposit',
      entity_id: row.id,
      action: 'edit',
      before: { status: row.status, gateway_adjustment_ref: linkedRef },
      after: {
        status: 'settled',
        amount: credited,
        replayed: outcome.replayed,
        gateway_adjustment_ref: ref,
        gateway_entry_id: entryId,
        entry_reported_amount: entry.reportedAmount,
      },
      reason,
    },
  ]);
  // Cleared only once the credit stands, as Credit deposit does.
  await packs.updateGatewayDeposits({ id: row.id, ...stampNote(row, null) });
  return {
    credited: true,
    replayed: outcome.replayed,
    amount: credited,
    ref,
    entryId,
  };
}

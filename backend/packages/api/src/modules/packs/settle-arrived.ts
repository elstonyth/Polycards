import { MedusaError } from '@medusajs/framework/utils';
import type PacksModuleService from './service';
import { resolvePacks, type GatewayDeposits } from './facets';
import {
  GATEWAYS,
  getDepositDetail,
  rowGateway,
  rowGatewayConfigs,
} from './gateway';
import { applyDepositOutcome, type DepositOutcomeRow } from './gateway-deposit';
import { rowFx } from './payment-fx';
import { toOptionalMoney } from './money';

// Staff settling a HELD deposit for what arrived (owner decision 2026-10-20).
// The deposit sweep credits a USDT payin that lands within the rail's
// payinArrivedTolerance of its order; further off it is held (still
// 'pending', or 'expired' when found by the sweep's second tier) and an ops
// alert asks staff to look. This is what they do then.
//
// The amount is NEVER typed by staff: it is the gateway's own requery,
// converted at the row's locked rate, credited through applyDepositOutcome
// with source 'requery' — the same idempotency anchor as the callback and
// the sweep, so no path can credit the deposit twice. Only rails that credit
// what arrived (payinArrivedTolerance) qualify: on an exact-amount gateway
// (A3Pay) an off-amount record is a slip at the gateway, to be corrected
// there, not credited here.

/** Held rows only: never 'settled' (paid) or 'failed' (the gateway said no). */
const HELD_STATUSES = new Set(['pending', 'expired']);

/** May staff settle this row for what arrived? A held row on a rail that
 *  credits what arrived. The admin list shows the action by this. */
export function canSettleArrived(row: {
  status: string;
  gateway?: string | null;
}): boolean {
  const gateway = rowGateway(row);
  return (
    HELD_STATUSES.has(row.status) &&
    gateway !== null &&
    GATEWAYS[gateway].payinArrivedTolerance !== undefined
  );
}

export type ArrivedQuote = {
  depositId: string;
  merchantTransactionId: string;
  customerId: string;
  currency: string;
  /** What the order asked for, in the gateway's currency. */
  ordered: number;
  /** What the gateway reports arrived, in its currency. */
  arrived: number;
  /** RM the order would have credited. */
  requested: number;
  /** RM to credit: what arrived, at the row's locked rate. */
  credit: number;
};

type Packs = GatewayDeposits &
  Pick<PacksModuleService, 'createAdminActionAudits'>;

type Scope = { resolve: <T>(key: string) => T };

const refuse = (message: string): never => {
  throw new MedusaError(MedusaError.Types.NOT_ALLOWED, message);
};

async function readHeld(scope: Scope, depositId: string) {
  const packs = resolvePacks<Packs>(scope);
  const [row] = await packs.listGatewayDeposits({ id: depositId }, { take: 1 });
  if (!row) {
    throw new MedusaError(MedusaError.Types.NOT_FOUND, 'No such deposit.');
  }
  if (!HELD_STATUSES.has(row.status)) {
    refuse(
      `This deposit is ${row.status}; only a held deposit can be settled.`,
    );
  }
  const gateway = rowGateway(row);
  if (!gateway || !GATEWAYS[gateway].payinArrivedTolerance) {
    refuse(
      'Only USDT deposits can be settled for what arrived. On this gateway an off-amount payment must be corrected by the gateway.',
    );
  }
  const config = rowGatewayConfigs()(row.gateway);
  if (!config) refuse(`${GATEWAYS[gateway!].label} is not configured here.`);
  let detail: Awaited<ReturnType<typeof getDepositDetail>>;
  try {
    detail = await getDepositDetail(
      row.merchant_transaction_id,
      config!,
      rowFx(row),
    );
  } catch (error) {
    // Ambiguous or refused: never settle on an answer we could not read.
    throw new MedusaError(
      MedusaError.Types.UNEXPECTED_STATE,
      `Could not read ${GATEWAYS[gateway!].label}'s record for this deposit (${(error as Error).message}). Try again.`,
    );
  }
  if (detail.state !== 'success') {
    refuse(
      `${GATEWAYS[gateway!].label} does not report this deposit as paid (${detail.state}), so there is nothing to credit.`,
    );
  }
  const credit = Number(detail.amount);
  if (!Number.isFinite(credit) || credit <= 0) {
    refuse(
      `${GATEWAYS[gateway!].label} reports no payable amount for this deposit.`,
    );
  }
  const ceiling = GATEWAYS[gateway!].limits.depositMax;
  if (credit > ceiling) {
    refuse(
      `RM ${credit.toFixed(2)} is over the RM ${ceiling} top-up ceiling; it cannot be settled here.`,
    );
  }
  const quote: ArrivedQuote = {
    depositId: row.id,
    merchantTransactionId: row.merchant_transaction_id,
    customerId: row.customer_id,
    currency: GATEWAYS[gateway!].currency,
    ordered: Number(row.gateway_amount),
    arrived: Number(detail.reportedAmount),
    requested: Number(row.amount_requested),
    credit,
  };
  return { packs, row, detail, quote };
}

/** What settling would credit, read live from the gateway. Moves nothing. */
export async function quoteArrivedDeposit(
  scope: Scope,
  depositId: string,
): Promise<ArrivedQuote> {
  return (await readHeld(scope, depositId)).quote;
}

/**
 * Settle a held deposit for what arrived. `expectedCredit` is the RM the
 * operator was shown: if the gateway's record moved since, nothing is
 * written and the new quote comes back (`changed`).
 */
export async function settleArrivedDeposit(
  scope: Scope,
  input: {
    depositId: string;
    expectedCredit: number;
    adminId: string;
    reason: string;
  },
): Promise<
  | { kind: 'settled'; quote: ArrivedQuote; replayed: boolean }
  | { kind: 'changed'; quote: ArrivedQuote }
> {
  const { packs, row, detail, quote } = await readHeld(scope, input.depositId);
  if (
    Math.round(input.expectedCredit * 100) !== Math.round(quote.credit * 100)
  ) {
    return { kind: 'changed', quote };
  }
  // The decision first, as deny/approve record theirs before any money: a
  // refused audit write stops here, so a credit can never land unrecorded.
  await packs.createAdminActionAudits([
    {
      admin_id: input.adminId,
      entity_type: 'gateway_deposit',
      entity_id: row.id,
      action: 'settle_deposit',
      before: {
        status: row.status,
        ordered: quote.ordered,
        requested: quote.requested,
      },
      after: {
        status: 'settled',
        arrived: quote.arrived,
        credit: quote.credit,
        currency: quote.currency,
      },
      reason: input.reason,
    },
  ]);
  const outcome = await applyDepositOutcome(scope, row as DepositOutcomeRow, {
    state: 'settled',
    source: 'requery',
    amount: quote.credit,
    gatewayRef: row.gateway_transaction_id || row.merchant_transaction_id,
    netAmount: toOptionalMoney(detail.netAmount),
    bankReferenceNo: detail.bankReferenceNo || null,
    uniqueReferenceNo: detail.uniqueReferenceNo || null,
    gatewayStatus: detail.statusId ?? null,
    settledAt: new Date(),
  });
  if (!outcome.applied) {
    refuse('The gateway reports no payable amount for this deposit.');
  }
  return {
    kind: 'settled',
    quote,
    replayed: outcome.applied && outcome.replayed,
  };
}

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import {
  resolvePacks,
  type GatewayDeposits,
  type GatewayWithdrawals,
} from '../../modules/packs/facets';
import {
  gmpayConfigFromEnv,
  gmpayPayinState,
  gmpayPayoutState,
  moved,
  readSignedCallback,
  type GmpayConfig,
} from '../../modules/packs/gmpay-client';
import { GATEWAYS, rowGateway } from '../../modules/packs/gateway';
import { applyDepositOutcome } from '../../modules/packs/gateway-deposit';
import { redactPayoutText } from '../../modules/packs/gateway-withdrawal';
import { handleWithdrawalCallback } from '../../modules/packs/withdrawal-callback';
import {
  callbackLedgerAmount,
  rowFx,
  toLedgerAmount,
} from '../../modules/packs/payment-fx';

// GMpay's inbound callbacks (PayFlowXZ API v3), bound by
// src/api/hooks/gmpay/{deposit,withdrawal}/route.ts.
//
// Authenticated by their SHA-256 signature over the fields AS SENT, which is
// why the route preserves the raw body (middlewares.ts): `100.00` re-read as
// 100 would hash differently. Nothing in a body is read for money before the
// signature checks out. They want the literal answer "OK"; delivery is at
// least once, so both handlers are idempotent.
//
// Their pay-in callback fires on success only (GMpay, 2026-11-19); a payment
// that never completes is closed by the deposit sweep's status check. Payouts
// call back on both completed and rejected.
//
// Amounts arrive in SGD and are converted to RM through the ROW's locked
// quote, so the money fences compare RM with RM as for every other gateway.

const TAG = '[gmpay]';
const OK = 'OK';

type Logger = { warn: (m: string) => void; error: (m: string) => void };
type Handler = (req: MedusaRequest, res: MedusaResponse) => Promise<void>;
type Fields = Record<string, string | null>;

/** The exact bytes received (the route preserves them). */
function rawBodyOf(req: MedusaRequest): string | undefined {
  const raw = (req as { rawBody?: Buffer | string }).rawBody;
  return raw === undefined ? undefined : raw.toString();
}

/** The config, or a 503 so they retry once this deploy has it. */
function configOr503(
  res: MedusaResponse,
  logger: Logger,
  what: string,
): GmpayConfig | null {
  try {
    return gmpayConfigFromEnv();
  } catch (error) {
    logger.error(
      `${TAG} ${what} callback arrived but GMpay is not configured: ${(error as Error).message}`,
    );
    res.status(503).send('unavailable');
    return null;
  }
}

/** The verified fields, or a 400 with one log line (never the body). */
function verifiedOr400(
  req: MedusaRequest,
  res: MedusaResponse,
  logger: Logger,
  config: GmpayConfig,
  what: string,
): Fields | null {
  const raw = rawBodyOf(req);
  try {
    if (!raw) throw new Error('no raw body (the route must preserve it)');
    return readSignedCallback(raw, config);
  } catch (error) {
    logger.warn(
      `${TAG} rejected ${what} callback: ${(error as Error).message}`,
    );
    res.status(400).send('rejected');
    return null;
  }
}

/** The amount that moved: the actual one when they send it, else the asked. */
const movedAmount = (fields: Fields): number => moved(fields);

/** status_code is their global result flag: 0 success, -1 error. */
function reportsError(fields: Fields): boolean {
  return fields.status_code !== null && fields.status_code !== undefined
    ? Number(fields.status_code) !== 0
    : false;
}

export const gmpayDepositCallback: Handler = async (req, res) => {
  const logger = req.scope.resolve<Logger>('logger');
  const config = configOr503(res, logger, 'deposit');
  if (!config) return;
  const fields = verifiedOr400(req, res, logger, config, 'deposit');
  if (!fields) return;

  const merchantTransactionId = String(fields.tran_unique ?? '');
  const token = String(fields.tran_token ?? '');
  if (!merchantTransactionId) {
    logger.error(`${TAG} deposit callback refused: no tran_unique`);
    res.status(400).send('rejected');
    return;
  }
  const state = gmpayPayinState(fields.tran_status);
  if (state === 'success' && reportsError(fields)) {
    // Completed and an error at once: never credit a contradiction.
    logger.error(
      `${TAG} deposit ${merchantTransactionId} callback says completed with status_code ${fields.status_code} (${fields.status_msg}) — not credited`,
    );
    res.status(400).send('rejected');
    return;
  }

  const packs = resolvePacks<GatewayDeposits>(req.scope);
  const [deposit] = await packs.listGatewayDeposits(
    { merchant_transaction_id: merchantTransactionId },
    { take: 1 },
  );
  if (!deposit) {
    logger.error(
      `${TAG} verified callback for UNKNOWN deposit ${merchantTransactionId} (${fields.tran_status}) — nothing credited`,
    );
    res.status(200).send(OK);
    return;
  }
  if (rowGateway(deposit) !== 'gmpay') {
    logger.error(
      `${TAG} callback names deposit ${merchantTransactionId}, which belongs to gateway "${deposit.gateway}" — ignored`,
    );
    res.status(200).send(OK);
    return;
  }
  // The token their create call returned is on the row. A callback naming
  // another token is another payment, whatever reference it carries.
  if (
    deposit.gateway_transaction_id &&
    token &&
    token !== deposit.gateway_transaction_id
  ) {
    logger.error(
      `${TAG} deposit ${merchantTransactionId} callback carries token ${token}, but the row holds ${deposit.gateway_transaction_id} — refused`,
    );
    res.status(400).send('rejected');
    return;
  }
  const gatewayTransactionId = deposit.gateway_transaction_id || token;

  if (deposit.status !== 'pending') {
    const recoverable =
      state === 'success' &&
      (deposit.status === 'failed' || deposit.status === 'expired');
    const contradicts =
      (state === 'success' && deposit.status !== 'settled') ||
      (state === 'failed' &&
        deposit.status !== 'failed' &&
        deposit.status !== 'expired');
    if (contradicts) {
      logger.error(
        `${TAG} deposit ${merchantTransactionId} callback says ${fields.tran_status} (${state}) but the row is already ${deposit.status}` +
          (recoverable
            ? ' — crediting a written-off deposit that the customer did pay'
            : ' — investigate'),
      );
    }
    if (!recoverable) {
      res.status(200).send(OK);
      return;
    }
  }

  if (state === 'pending') {
    res.status(200).send(OK);
    return;
  }

  if (state === 'failed') {
    await applyDepositOutcome(req.scope, deposit, {
      state: 'expired',
      gatewayTransactionId,
    });
    res.status(200).send(OK);
    return;
  }

  const fx = rowFx(deposit);
  const paid = movedAmount(fields);
  const creditedAmount = callbackLedgerAmount(
    fx,
    paid,
    GATEWAYS.gmpay.payinNudgeCents,
  );
  const fee = Number(fields.tran_fee);
  try {
    const outcome = await applyDepositOutcome(req.scope, deposit, {
      state: 'settled',
      source: 'callback',
      amount: creditedAmount,
      gatewayRef: gatewayTransactionId || merchantTransactionId,
      gatewayTransactionId,
      // What reached our wallet, at the same locked rate. Unknown stays unknown.
      netAmount:
        fields.tran_fee !== null &&
        Number.isFinite(fee) &&
        Number.isFinite(paid)
          ? toLedgerAmount(fx, paid - fee)
          : null,
      settledAt: new Date(),
    });
    if (!outcome.applied) {
      logger.error(
        outcome.reason === 'hand-credited'
          ? `${TAG} settled callback for ${merchantTransactionId}, but a hand adjustment already names this deposit — refusing to credit; the row remains ${deposit.status}`
          : `${TAG} settled callback for ${merchantTransactionId} claims ${config.currencyCode} ${String(paid)} (RM ${creditedAmount}) but the row asked for ${config.currencyCode} ${String(deposit.gateway_amount)} (RM ${Number(deposit.amount_requested)}) — refusing to credit; the row remains ${deposit.status} for the sweep`,
      );
      res.status(400).send('rejected');
      return;
    }
  } catch (error) {
    logger.error(
      `${TAG} failed to credit deposit ${merchantTransactionId}: ${(error as Error).message}`,
    );
    res.status(500).send('error');
    return;
  }

  res.status(200).send(OK);
};

export const gmpayWithdrawalCallback: Handler = async (req, res) => {
  const logger = req.scope.resolve<Logger>('logger');
  const config = configOr503(res, logger, 'withdrawal');
  if (!config) return;
  const fields = verifiedOr400(req, res, logger, config, 'withdrawal');
  if (!fields) return;

  const merchantTransactionId = String(fields.tran_unique ?? '');
  const token = String(fields.tran_token ?? '');
  if (!merchantTransactionId) {
    logger.error(`${TAG} withdrawal callback refused: no tran_unique`);
    res.status(400).send('rejected');
    return;
  }
  const state = gmpayPayoutState(fields.tran_status);
  if (state === 'success' && reportsError(fields)) {
    logger.error(
      `${TAG} payout ${merchantTransactionId} callback says completed with status_code ${fields.status_code} (${fields.status_msg}) — not applied`,
    );
    res.status(400).send('rejected');
    return;
  }

  // Same token rule as deposits, checked here because the shared state
  // machine below trusts the row it finds.
  const packs = resolvePacks<GatewayWithdrawals>(req.scope);
  const [row] = await packs.listGatewayWithdrawals(
    { merchant_transaction_id: merchantTransactionId, gateway: 'gmpay' },
    { take: 1 },
  );
  if (
    row?.gateway_transaction_id &&
    token &&
    token !== row.gateway_transaction_id
  ) {
    logger.error(
      `${TAG} payout ${merchantTransactionId} callback carries token ${token}, but the row holds ${row.gateway_transaction_id} — refused`,
    );
    res.status(400).send('rejected');
    return;
  }

  const paid = movedAmount(fields);
  const fee = Number(fields.tran_fee);
  const answer = await handleWithdrawalCallback(req.scope, {
    kind: 'gmpay',
    label: 'GMpay',
    find: { merchantTransactionId },
    rawStatus: String(fields.tran_status ?? ''),
    state,
    gatewayTransactionId: (withdrawal) =>
      withdrawal.gateway_transaction_id || token,
    // In RM at the row's locked rate, the audit's own unit.
    paidAmount: (withdrawal) => toLedgerAmount(rowFx(withdrawal), paid),
    // Free text their operator typed: it can echo the account number or the
    // holder name, and this column renders on the admin list.
    failureReason: (withdrawal) =>
      `callback ${String(fields.tran_status ?? '')}: ${redactPayoutText(String(fields.tran_reject_reason ?? ''), withdrawal.account_number, withdrawal.account_holder_name ?? '').slice(0, 200)}`,
    // No amount in the callback is not a different amount.
    amountMismatch: (withdrawal) =>
      Number.isFinite(paid) &&
      Math.round(paid * 100) !==
        Math.round(Number(withdrawal.gateway_amount) * 100)
        ? {
            note: `GMpay settled payout ${merchantTransactionId} at ${config.currencyCode} ${String(paid)}, but ${config.currencyCode} ${String(withdrawal.gateway_amount)} was submitted (RM ${withdrawal.amount} debited) — investigate before adjusting.`,
            alert: true,
          }
        : null,
    settlement: (withdrawal, gatewayTransactionId) => {
      const fx = rowFx(withdrawal);
      const settledAmount = toLedgerAmount(fx, paid);
      // A payout's net is what our wallet PAID (amount + their fee).
      const net =
        fields.tran_fee !== null && Number.isFinite(fee)
          ? toLedgerAmount(fx, paid + fee)
          : NaN;
      return {
        gatewayRef: gatewayTransactionId || merchantTransactionId,
        gatewayTransactionId: gatewayTransactionId || null,
        amountSettled: Number.isFinite(settledAmount) ? settledAmount : null,
        netAmount: Number.isFinite(net) ? net : null,
        settledAt: new Date(),
      };
    },
  });
  res.status(answer.status).send(answer.status === 200 ? OK : answer.body);
};

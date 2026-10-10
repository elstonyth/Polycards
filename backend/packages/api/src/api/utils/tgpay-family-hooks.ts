import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import {
  resolvePacks,
  type GatewayDeposits,
  type GatewayWithdrawals,
} from '../../modules/packs/facets';
import {
  TGPAY_FAMILY,
  tgpayCallbackAuthorized,
  tgpayFamilyConfigFromEnv,
  tgpayPaymentState,
  tgpayPayoutState,
  type TgpayKind,
} from '../../modules/packs/tgpay-client';
import { GATEWAYS, rowGateway } from '../../modules/packs/gateway';
import { applyDepositOutcome } from '../../modules/packs/gateway-deposit';
import {
  applyWithdrawalOutcome,
  refundWithdrawal,
} from '../../modules/packs/gateway-withdrawal';
import { alertOps } from '../../modules/packs/ops-alert';
import { payoutCost, toOptionalMoney } from '../../modules/packs/money';

// The server-notify handlers for every gateway on the TGPay platform (TGPay,
// The 7 Pay): one wire format, so one implementation, bound per gateway by
// src/api/hooks/<gateway>/{deposit,withdrawal}/route.ts. The gateway id picks
// the keys that authenticate the callback, the rows it may touch, and the log
// prefix. Both are idempotent — the platform delivers at least once.

type Logger = { warn: (m: string) => void; error: (m: string) => void };
type Handler = (req: MedusaRequest, res: MedusaResponse) => Promise<void>;

/** The exact bytes received, when the route preserves them (HMAC Method 2). */
function rawBodyOf(req: MedusaRequest): string | undefined {
  const raw = (req as { rawBody?: Buffer | string }).rawBody;
  return raw === undefined ? undefined : raw.toString();
}

type PaymentNotify = {
  amount?: unknown;
  transactionRefNum?: unknown;
  merchantRefNum?: unknown;
  paymentMethod?: unknown;
  bankName?: unknown;
  status?: unknown;
};

/**
 * Payment server-notify (docs "Payment callback"). The key headers or the
 * HMAC signature are the whole authentication (plus the source allowlist in
 * middlewares).
 */
export function tgpayDepositCallback(kind: TgpayKind): Handler {
  const tag = `[${kind}]`;
  return async (req, res) => {
    const logger = req.scope.resolve<Logger>('logger');
    const config = tgpayFamilyConfigFromEnv(kind);

    if (
      !tgpayCallbackAuthorized(
        req.headers as Record<string, unknown>,
        config,
        rawBodyOf(req),
      )
    ) {
      logger.warn(
        `${tag} rejected deposit callback: key headers or signature missing or wrong`,
      );
      res.status(401).send('rejected');
      return;
    }

    // Documented shape is { status, msg, data: {...} }; accept a flat body too so
    // a sandbox/production difference in wrapping cannot silently drop money.
    const body = (req.body ?? {}) as { data?: PaymentNotify } & PaymentNotify;
    const data: PaymentNotify = body.data ?? body;

    const merchantTransactionId =
      typeof data.merchantRefNum === 'string' ? data.merchantRefNum : '';
    const gatewayTransactionId =
      typeof data.transactionRefNum === 'string' ? data.transactionRefNum : '';
    if (!merchantTransactionId) {
      logger.warn(`${tag} rejected deposit callback: no merchantRefNum`);
      res.status(400).send('rejected');
      return;
    }
    const state = tgpayPaymentState(String(data.status ?? ''));

    const packs = resolvePacks<GatewayDeposits>(req.scope);
    const [deposit] = await packs.listGatewayDeposits(
      { merchant_transaction_id: merchantTransactionId },
      { take: 1 },
    );
    if (!deposit) {
      logger.error(
        `${tag} verified callback for UNKNOWN deposit ${merchantTransactionId} (gateway ${gatewayTransactionId}, status ${String(data.status)}) — nothing credited`,
      );
      res.status(200).send('success');
      return;
    }
    // A callback authenticated with one gateway's keys may only ever touch
    // that gateway's row. The references are random and cannot collide in
    // practice; this is the cheap guarantee that a switch between gateways —
    // or two gateways on the same platform — cannot cross-credit.
    if (rowGateway(deposit) !== kind) {
      logger.error(
        `${tag} callback names deposit ${merchantTransactionId}, which belongs to gateway "${deposit.gateway}" — ignored`,
      );
      res.status(200).send('success');
      return;
    }

    if (deposit.status !== 'pending') {
      const recoverable =
        state === 'success' &&
        (deposit.status === 'failed' || deposit.status === 'expired');
      const contradicts =
        (state === 'success' && deposit.status !== 'settled') ||
        (state === 'failed' && deposit.status !== 'failed');
      if (contradicts) {
        logger.error(
          `${tag} deposit ${merchantTransactionId} callback says ${String(data.status)} (${state}) but the row is already ${deposit.status} (gateway ${gatewayTransactionId})` +
            (recoverable
              ? ' — crediting a written-off deposit that the customer did pay'
              : ' — investigate'),
        );
      }
      if (!recoverable) {
        res.status(200).send('success');
        return;
      }
    }

    if (state === 'pending') {
      res.status(200).send('success');
      return;
    }

    // Their id, when this callback carries one; never blanking what the row
    // already holds. Both branches below write it.
    const learnedId = gatewayTransactionId || deposit.gateway_transaction_id;

    if (state === 'failed') {
      await applyDepositOutcome(req.scope, deposit, {
        state: 'failed',
        gatewayTransactionId: learnedId,
      });
      res.status(200).send('success');
      return;
    }

    const creditedAmount = Number(data.amount);
    try {
      // The whole settle sequence — fences, credit, receipt, row claim, feed —
      // lives in applyDepositOutcome, shared verbatim with the reconcile sweep.
      // The amount fences are its first two steps and write nothing, so a
      // refusal here is the same 400-and-leave-it-alone this route always
      // answered. bankName is a display name, not a bank reference, so it is
      // not stored in the reference columns; the callback carries no fee, so
      // net_amount is left for the audit sweep to backfill.
      const outcome = await applyDepositOutcome(req.scope, deposit, {
        state: 'settled',
        // An unsolicited POST: its amount is fenced against the row. The sweep
        // passes 'requery' and is trusted verbatim — see DepositOutcome.source.
        source: 'callback',
        amount: creditedAmount,
        gatewayRef: gatewayTransactionId || merchantTransactionId,
        gatewayTransactionId: learnedId,
        settledAt: new Date(),
      });
      if (!outcome.applied) {
        logger.error(
          outcome.reason === 'amount-not-positive'
            ? `${tag} settled callback for ${merchantTransactionId} carried a non-positive amount (${String(data.amount)}) — refusing to credit`
            : `${tag} settled callback for ${merchantTransactionId} claims RM ${creditedAmount} but the row asked for RM ${Number(deposit.amount_requested)} (ceiling RM ${GATEWAYS[kind].limits.depositMax}) — refusing to credit; the row remains ${deposit.status} for the sweep`,
        );
        res.status(400).send('rejected');
        return;
      }
    } catch (error) {
      logger.error(
        `${tag} failed to credit deposit ${merchantTransactionId}: ${(error as Error).message}`,
      );
      res.status(500).send('error');
      return;
    }

    res.status(200).send('success');
  };
}

type PayoutNotify = {
  transactionId?: unknown;
  status?: unknown;
  amount?: unknown;
  fee?: unknown;
  paymentAt?: unknown;
  orderno?: unknown;
  payType?: unknown;
};

/**
 * Payout server-notify (docs "Payout callback"). Flat body, no wrapper, and —
 * unlike every other message — NO merchantRefNum: the row is found by the
 * transactionRefNum we stored at create time. The refund path is the shared
 * helper the sweep and the admin deny route already use.
 */
export function tgpayWithdrawalCallback(kind: TgpayKind): Handler {
  const tag = `[${kind}]`;
  const label = TGPAY_FAMILY[kind].label;
  return async (req, res) => {
    const logger = req.scope.resolve<Logger>('logger');
    const config = tgpayFamilyConfigFromEnv(kind);

    if (
      !tgpayCallbackAuthorized(
        req.headers as Record<string, unknown>,
        config,
        rawBodyOf(req),
      )
    ) {
      logger.warn(
        `${tag} rejected withdrawal callback: key headers or signature missing or wrong`,
      );
      res.status(401).send('rejected');
      return;
    }

    const body = (req.body ?? {}) as { data?: PayoutNotify } & PayoutNotify;
    const data: PayoutNotify = body.data ?? body;
    const gatewayTransactionId =
      typeof data.transactionId === 'string' && data.transactionId
        ? data.transactionId
        : typeof data.orderno === 'string'
          ? data.orderno
          : '';
    if (!gatewayTransactionId) {
      logger.warn(`${tag} rejected withdrawal callback: no transactionId`);
      res.status(400).send('rejected');
      return;
    }
    const state = tgpayPayoutState(String(data.status ?? ''));

    const packs = resolvePacks<GatewayWithdrawals>(req.scope);
    // Primary key: the transactionRefNum stored right after create-payout. If
    // the callback outruns that write (their id is issued in the same response
    // we are still handling), fall back to OUR reference — on the sandbox the
    // two are the same string. A miss after both is acknowledged and left to
    // the payout sweep, which queries by our reference.
    let [withdrawal] = await packs.listGatewayWithdrawals(
      { gateway_transaction_id: gatewayTransactionId, gateway: kind },
      { take: 1 },
    );
    if (!withdrawal) {
      [withdrawal] = await packs.listGatewayWithdrawals(
        { merchant_transaction_id: gatewayTransactionId, gateway: kind },
        { take: 1 },
      );
    }
    if (!withdrawal) {
      logger.error(
        `${tag} verified withdrawal callback for UNKNOWN payout ${gatewayTransactionId} (status ${String(data.status)}) — nothing changed; the sweep will requery`,
      );
      res.status(200).send('success');
      return;
    }
    // Belt and braces with the gateway filter on both selectors above: a row
    // that somehow answered without being this gateway's is refused, not paid.
    if (rowGateway(withdrawal) !== kind) {
      logger.error(
        `${tag} callback names payout ${withdrawal.merchant_transaction_id}, which belongs to gateway "${withdrawal.gateway}" — ignored`,
      );
      res.status(200).send('success');
      return;
    }
    const merchantTransactionId = withdrawal.merchant_transaction_id;

    if (withdrawal.status !== 'pending') {
      const contradicts =
        (state === 'success' && withdrawal.status !== 'settled') ||
        (state === 'failed' && withdrawal.status !== 'failed');
      if (contradicts) {
        logger.error(
          `${tag} withdrawal ${merchantTransactionId} callback says ${String(data.status)} (${state}) but the row is already ${withdrawal.status} — possible double payment, investigate (gateway ${gatewayTransactionId})`,
        );
        // A log line alone is read only when someone already suspects a problem;
        // a paid-after-refund payout is real money gone twice. References only.
        void alertOps(
          req.scope,
          'payout-contradiction',
          `${label} says payout ${merchantTransactionId} is ${state}, but our row is already ${withdrawal.status}` +
            (state === 'success'
              ? ' — the customer may have been refunded AND paid.'
              : '.') +
            ` Investigate ${label} ${gatewayTransactionId}.`,
        );
      }
      res.status(200).send('success');
      return;
    }

    if (state === 'pending') {
      res.status(200).send('success');
      return;
    }

    if (state === 'failed') {
      try {
        await refundWithdrawal(
          req.scope,
          withdrawal,
          null,
          'pending',
          `callback ${String(data.status)} at ${String(data.paymentAt ?? '')}`,
        );
      } catch (error) {
        logger.error(
          `${tag} failed to refund withdrawal ${merchantTransactionId}: ${(error as Error).message}`,
        );
        res.status(500).send('error');
        return;
      }
      res.status(200).send('success');
      return;
    }

    if (Number(data.amount) !== Number(withdrawal.amount)) {
      logger.error(
        `${tag} withdrawal ${merchantTransactionId} settled at ${String(data.amount)}, but ${withdrawal.amount} was debited — investigate before adjusting`,
      );
    }

    // Receipt -> claim -> feed, shared with the payout sweep. The callback
    // carries no bank references, so those columns are left alone.
    await applyWithdrawalOutcome(req.scope, withdrawal, {
      gatewayRef: gatewayTransactionId,
      gatewayTransactionId:
        withdrawal.gateway_transaction_id ?? gatewayTransactionId,
      amountSettled: toOptionalMoney(data.amount),
      // net_amount on a payout is what the wallet PAID — amount + fee (the
      // platform charges on top). NULL when the callback omits the fee — never
      // a zero fee by omission.
      netAmount: payoutCost(data.amount, data.fee),
      settledAt: new Date(),
    });

    res.status(200).send('success');
  };
}

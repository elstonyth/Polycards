import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import {
  resolvePacks,
  type GatewayDeposits,
} from '../../../../modules/packs/facets';
import {
  tgpayCallbackAuthorized,
  tgpayConfigFromEnv,
  tgpayPaymentState,
} from '../../../../modules/packs/tgpay-client';
import { GATEWAYS, rowGateway } from '../../../../modules/packs/gateway';
import { applyDepositOutcome } from '../../../../modules/packs/gateway-deposit';

// TGPay payment server-notify (docs "Payment callback"). The two key headers
// are the whole authentication (plus the source allowlist in middlewares).
// Idempotent — TGPay delivers at least once.

type PaymentNotify = {
  amount?: unknown;
  transactionRefNum?: unknown;
  merchantRefNum?: unknown;
  paymentMethod?: unknown;
  bankName?: unknown;
  status?: unknown;
};

type Logger = { warn: (m: string) => void; error: (m: string) => void };

export async function POST(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const logger = req.scope.resolve<Logger>('logger');
  const config = tgpayConfigFromEnv();

  if (
    !tgpayCallbackAuthorized(req.headers as Record<string, unknown>, config)
  ) {
    logger.warn(
      '[tgpay] rejected deposit callback: key headers missing or wrong',
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
    logger.warn('[tgpay] rejected deposit callback: no merchantRefNum');
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
      `[tgpay] verified callback for UNKNOWN deposit ${merchantTransactionId} (gateway ${gatewayTransactionId}, status ${String(data.status)}) — nothing credited`,
    );
    res.status(200).send('success');
    return;
  }
  // A TGPay-authenticated callback may only ever touch a TGPay row. The
  // references are random and cannot collide in practice; this is the cheap
  // guarantee that a switch between gateways cannot cross-credit.
  if (rowGateway(deposit) !== 'tgpay') {
    logger.error(
      `[tgpay] callback names deposit ${merchantTransactionId}, which belongs to gateway "${deposit.gateway}" — ignored`,
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
        `[tgpay] deposit ${merchantTransactionId} callback says ${String(data.status)} (${state}) but the row is already ${deposit.status} (gateway ${gatewayTransactionId})` +
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
          ? `[tgpay] settled callback for ${merchantTransactionId} carried a non-positive amount (${String(data.amount)}) — refusing to credit`
          : `[tgpay] settled callback for ${merchantTransactionId} claims RM ${creditedAmount} but the row asked for RM ${Number(deposit.amount_requested)} (ceiling RM ${GATEWAYS.tgpay.limits.depositMax}) — refusing to credit; the row remains ${deposit.status} for the sweep`,
      );
      res.status(400).send('rejected');
      return;
    }
  } catch (error) {
    logger.error(
      `[tgpay] failed to credit deposit ${merchantTransactionId}: ${(error as Error).message}`,
    );
    res.status(500).send('error');
    return;
  }

  res.status(200).send('success');
}

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import {
  resolvePacks,
  type GatewayDeposits,
} from '../../../../modules/packs/facets';
import { signatureMismatchAlert } from '../../../utils/a3pay-signature-alert';
import { openCallback, payinState } from '../../../../modules/packs/a3pay';
import { a3payConfigFromEnv } from '../../../../modules/packs/a3pay-client';
import { rowGateway } from '../../../../modules/packs/gateway';
import {
  alertPayinVerifyFail,
  applyDepositOutcome,
  isPayinVerifyFail,
} from '../../../../modules/packs/gateway-deposit';
import {
  callbackLedgerAmount,
  rowFx,
  toLedgerAmount,
} from '../../../../modules/packs/payment-fx';

// A3Pay payin callback (handbook "Payin Callback"). Authenticated by the RSA
// signature over the DECRYPTED Data — nothing in the body is read for money
// before openCallback has verified it, and the reference comes from the SIGNED
// Data, never from the envelope beside it. Answer "success" and they stop
// resending. Idempotent: delivery is at least once.
//
// Amounts arrive in SGD and are converted to RM through the ROW's locked quote
// (payment-fx.ts), so the amount fence in applyDepositOutcome compares RM with
// RM exactly as it does for the RM gateway.

type Envelope = {
  TransactionId?: unknown;
  MerchantTransactionId?: unknown;
  Data?: unknown;
  Signature?: unknown;
};

type PayinData = {
  MerchantCode?: string;
  CurrencyCode?: string;
  MerchantTransactionId?: string;
  Status?: number;
  Amount?: number | string;
  NetAmount?: number | string;
  PaymentMethodCode?: string;
};

type Logger = { warn: (m: string) => void; error: (m: string) => void };

export async function POST(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const logger = req.scope.resolve<Logger>('logger');
  let config: ReturnType<typeof a3payConfigFromEnv>;
  try {
    config = a3payConfigFromEnv();
  } catch (error) {
    // Not configured on this deploy. 503, so A3Pay retries once it is,
    // rather than an unhandled 500 with a stack in the logs.
    logger.error(
      `[a3pay] deposit callback arrived but A3Pay is not configured: ${(error as Error).message}`,
    );
    res.status(503).send('unavailable');
    return;
  }
  const body = (req.body ?? {}) as Envelope;

  let data: PayinData;
  try {
    if (typeof body.Data !== 'string' || typeof body.Signature !== 'string') {
      throw new Error('missing Data or Signature');
    }
    data = openCallback<PayinData>(
      { Data: body.Data, Signature: body.Signature },
      config,
    );
  } catch (error) {
    logger.warn(
      `[a3pay] rejected deposit callback: ${(error as Error).message}`,
    );
    signatureMismatchAlert(req.scope, error, 'deposit callback');
    res.status(400).send('rejected');
    return;
  }

  // The signature proves A3Pay sent it, not that it is OUR merchant's or in
  // our currency. Both are read from the signed copy.
  const merchantTransactionId = String(data.MerchantTransactionId ?? '');
  if (
    String(data.MerchantCode ?? '').toUpperCase() !==
      config.merchantCode.toUpperCase() ||
    String(data.CurrencyCode ?? '').toUpperCase() !==
      config.currencyCode.toUpperCase() ||
    !merchantTransactionId
  ) {
    logger.error(
      `[a3pay] deposit callback refused: merchant ${data.MerchantCode} / currency ${data.CurrencyCode} / ref ${merchantTransactionId || 'none'} does not match ${config.merchantCode}/${config.currencyCode}`,
    );
    res.status(400).send('rejected');
    return;
  }
  const state = payinState(data.Status);

  const packs = resolvePacks<GatewayDeposits>(req.scope);
  const [deposit] = await packs.listGatewayDeposits(
    { merchant_transaction_id: merchantTransactionId },
    { take: 1 },
  );
  if (!deposit) {
    logger.error(
      `[a3pay] verified callback for UNKNOWN deposit ${merchantTransactionId} (status ${String(data.Status)}) — nothing credited`,
    );
    res.status(200).send('success');
    return;
  }
  // An A3Pay-signed callback may only ever touch an A3Pay row.
  if (rowGateway(deposit) !== 'a3pay') {
    logger.error(
      `[a3pay] callback names deposit ${merchantTransactionId}, which belongs to gateway "${deposit.gateway}" — ignored`,
    );
    res.status(200).send('success');
    return;
  }

  // Their id: the one CreatePayin returned (stored on the row) wins; the
  // envelope's copy is unsigned, so it is only ever a fallback label.
  const gatewayTransactionId =
    deposit.gateway_transaction_id ||
    (typeof body.TransactionId === 'string' ? body.TransactionId : '');

  if (deposit.status !== 'pending') {
    const recoverable =
      state === 'success' &&
      (deposit.status === 'failed' || deposit.status === 'expired');
    const contradicts =
      (state === 'success' && deposit.status !== 'settled') ||
      (state === 'failed' && deposit.status !== 'failed');
    if (contradicts) {
      logger.error(
        `[a3pay] deposit ${merchantTransactionId} callback says ${String(data.Status)} (${state}) but the row is already ${deposit.status}` +
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
    if (isPayinVerifyFail('a3pay', data.Status)) {
      alertPayinVerifyFail(req.scope, deposit);
    }
    res.status(200).send('success');
    return;
  }

  if (state === 'failed') {
    await applyDepositOutcome(req.scope, deposit, {
      state: 'failed',
      gatewayTransactionId,
    });
    res.status(200).send('success');
    return;
  }

  const fx = rowFx(deposit);
  const paid = Number(data.Amount);
  // The locked RM credit for the locked S$ amount — or for a small upward
  // nudge of it, which A3Pay applies to keep same-amount SGD transfers apart
  // and which the customer actually pays (payment-fx.ts PAYIN_NUDGE_CENTS).
  const creditedAmount = callbackLedgerAmount(fx, paid);
  const net = Number(data.NetAmount);
  try {
    const outcome = await applyDepositOutcome(req.scope, deposit, {
      state: 'settled',
      source: 'callback',
      amount: creditedAmount,
      gatewayRef: gatewayTransactionId || merchantTransactionId,
      gatewayTransactionId,
      gatewayStatus: Number(data.Status),
      // Their fee, converted at the same locked rate. Unknown stays unknown.
      netAmount: Number.isFinite(net) ? toLedgerAmount(fx, net) : null,
      settledAt: new Date(),
    });
    if (!outcome.applied) {
      logger.error(
        `[a3pay] settled callback for ${merchantTransactionId} claims ${config.currencyCode} ${String(data.Amount)} (RM ${creditedAmount}) but the row asked for ${config.currencyCode} ${String(deposit.gateway_amount)} (RM ${Number(deposit.amount_requested)}) — refusing to credit; the row remains ${deposit.status} for the sweep`,
      );
      res.status(400).send('rejected');
      return;
    }
  } catch (error) {
    logger.error(
      `[a3pay] failed to credit deposit ${merchantTransactionId}: ${(error as Error).message}`,
    );
    res.status(500).send('error');
    return;
  }

  res.status(200).send('success');
}

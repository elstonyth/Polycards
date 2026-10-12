import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import {
  resolvePacks,
  type GatewayWithdrawals,
} from '../../../../modules/packs/facets';
import { openCallback, payoutState } from '../../../../modules/packs/a3pay';
import { a3payConfigFromEnv } from '../../../../modules/packs/a3pay-client';
import {
  applyWithdrawalOutcome,
  refundWithdrawal,
} from '../../../../modules/packs/gateway-withdrawal';
import { rowGateway } from '../../../../modules/packs/gateway';
import { alertOps } from '../../../../modules/packs/ops-alert';
import { rowFx, toLedgerAmount } from '../../../../modules/packs/payment-fx';

// A3Pay payout callback (handbook "Payout Callback"). Same authentication as
// the deposit hook: decrypt, verify the signature, then read only the signed
// Data. Same transitions as the TGPay payout hook — the refund and the settle
// are the helpers the sweep and the admin routes share. Amounts are SGD and
// are converted to RM through the row's locked quote before they are stored.

type Envelope = {
  TransactionId?: unknown;
  Data?: unknown;
  Signature?: unknown;
};

type PayoutData = {
  MerchantCode?: string;
  CurrencyCode?: string;
  MerchantTransactionId?: string;
  Status?: number;
  Amount?: number | string;
  NetAmount?: number | string;
  Remark?: string;
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
      `[a3pay] withdrawal callback arrived but A3Pay is not configured: ${(error as Error).message}`,
    );
    res.status(503).send('unavailable');
    return;
  }
  const body = (req.body ?? {}) as Envelope;

  let data: PayoutData;
  try {
    if (typeof body.Data !== 'string' || typeof body.Signature !== 'string') {
      throw new Error('missing Data or Signature');
    }
    data = openCallback<PayoutData>(
      { Data: body.Data, Signature: body.Signature },
      config,
    );
  } catch (error) {
    logger.warn(
      `[a3pay] rejected withdrawal callback: ${(error as Error).message}`,
    );
    res.status(400).send('rejected');
    return;
  }

  const merchantTransactionId = String(data.MerchantTransactionId ?? '');
  if (
    String(data.MerchantCode ?? '').toUpperCase() !==
      config.merchantCode.toUpperCase() ||
    String(data.CurrencyCode ?? '').toUpperCase() !==
      config.currencyCode.toUpperCase() ||
    !merchantTransactionId
  ) {
    logger.error(
      `[a3pay] withdrawal callback refused: merchant ${data.MerchantCode} / currency ${data.CurrencyCode} / ref ${merchantTransactionId || 'none'} does not match ${config.merchantCode}/${config.currencyCode}`,
    );
    res.status(400).send('rejected');
    return;
  }
  const state = payoutState(data.Status);

  const packs = resolvePacks<GatewayWithdrawals>(req.scope);
  const [withdrawal] = await packs.listGatewayWithdrawals(
    { merchant_transaction_id: merchantTransactionId, gateway: 'a3pay' },
    { take: 1 },
  );
  if (!withdrawal || rowGateway(withdrawal) !== 'a3pay') {
    logger.error(
      `[a3pay] verified withdrawal callback for UNKNOWN payout ${merchantTransactionId} (status ${String(data.Status)}) — nothing changed; the sweep will requery`,
    );
    res.status(200).send('success');
    return;
  }
  const gatewayTransactionId =
    withdrawal.gateway_transaction_id ||
    (typeof body.TransactionId === 'string' ? body.TransactionId : '');

  if (withdrawal.status !== 'pending') {
    const contradicts =
      (state === 'success' && withdrawal.status !== 'settled') ||
      (state === 'failed' && withdrawal.status !== 'failed');
    if (contradicts) {
      logger.error(
        `[a3pay] withdrawal ${merchantTransactionId} callback says ${String(data.Status)} (${state}) but the row is already ${withdrawal.status} — possible double payment, investigate (gateway ${gatewayTransactionId})`,
      );
      void alertOps(
        req.scope,
        'payout-contradiction',
        `A3Pay says payout ${merchantTransactionId} is ${state}, but our row is already ${withdrawal.status}` +
          (state === 'success'
            ? ' — the customer may have been refunded AND paid.'
            : '.') +
          ` Investigate A3Pay ${gatewayTransactionId}.`,
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
        `callback status ${String(data.Status)}: ${String(data.Remark ?? '').slice(0, 200)}`,
      );
    } catch (error) {
      logger.error(
        `[a3pay] failed to refund withdrawal ${merchantTransactionId}: ${(error as Error).message}`,
      );
      res.status(500).send('error');
      return;
    }
    res.status(200).send('success');
    return;
  }

  if (
    Math.round(Number(data.Amount) * 100) !==
    Math.round(Number(withdrawal.gateway_amount) * 100)
  ) {
    const note = `A3Pay settled payout ${merchantTransactionId} at ${config.currencyCode} ${String(data.Amount)}, but ${config.currencyCode} ${String(withdrawal.gateway_amount)} was submitted (RM ${withdrawal.amount} debited) — investigate before adjusting.`;
    logger.error(`[a3pay] ${note}`);
    // Money left in a different amount than we debited for: someone must
    // look, and a log line is read only by someone already suspicious.
    void alertOps(req.scope, 'payout-contradiction', note);
  }

  const fx = rowFx(withdrawal);
  const settledAmount = toLedgerAmount(fx, Number(data.Amount));
  const net = toLedgerAmount(fx, Number(data.NetAmount));
  await applyWithdrawalOutcome(req.scope, withdrawal, {
    gatewayRef: gatewayTransactionId || merchantTransactionId,
    gatewayTransactionId: gatewayTransactionId || null,
    amountSettled: Number.isFinite(settledAmount) ? settledAmount : null,
    // A payout's net is what our wallet PAID (amount + their fee), in RM at
    // the locked rate. Unknown stays NULL, never a zero fee.
    netAmount: Number.isFinite(net) ? net : null,
    settledAt: new Date(),
  });

  res.status(200).send('success');
}

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { PACKS_MODULE } from '../../../../modules/packs';
import type PacksModuleService from '../../../../modules/packs/service';
import {
  tgpayCallbackAuthorized,
  tgpayConfigFromEnv,
  tgpayPaymentState,
} from '../../../../modules/packs/tgpay-client';
import { GLOBEPAY_MAX_RM } from '../../../../modules/packs/globepay-deposit';
import { topupIdempotencyReference } from '../../../../modules/packs/topup';
import { sendTopupReceipt } from '../../../../modules/packs/topup-receipt';
import { notifyFeed } from '../../../../modules/packs/notify-feed';
import { topupFeedKey } from '../../../../modules/packs/feed-events';

// TGPay payment server-notify (docs "Payment callback"). Same state machine as
// the GlobePay deposit hook (src/api/hooks/globepay/deposit/route.ts), minus
// the crypto: the two key headers are the whole authentication. Idempotent —
// TGPay delivers at least once.

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

  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const [deposit] = await packs.listGlobePayDeposits(
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

  if (state === 'failed') {
    await packs.updateGlobePayDeposits({
      selector: { id: deposit.id, status: 'pending' },
      data: {
        status: 'failed',
        gateway_transaction_id:
          gatewayTransactionId || deposit.gateway_transaction_id,
      },
    });
    res.status(200).send('success');
    return;
  }

  const creditedAmount = Number(data.amount);
  if (!Number.isFinite(creditedAmount) || creditedAmount <= 0) {
    logger.error(
      `[tgpay] settled callback for ${merchantTransactionId} carried a non-positive amount (${String(data.amount)}) — refusing to credit`,
    );
    res.status(400).send('rejected');
    return;
  }
  if (creditedAmount > GLOBEPAY_MAX_RM) {
    logger.error(
      `[tgpay] settled callback for ${merchantTransactionId} claims ${creditedAmount}, above the RM ${GLOBEPAY_MAX_RM} deposit ceiling — refusing to credit; the row remains ${deposit.status} for manual settlement`,
    );
    res.status(400).send('rejected');
    return;
  }

  const reference = gatewayTransactionId || merchantTransactionId;
  try {
    const mutation = await packs.topUpCreditsWithLedger({
      customerId: deposit.customer_id,
      amount: creditedAmount,
      reason: 'topup',
      ledgerPaymentMethod: deposit.payment_method_code,
      ledgerGatewayRef: reference,
      reference,
      idempotencyReference: topupIdempotencyReference(
        deposit.customer_id,
        merchantTransactionId,
      ),
    });
    await sendTopupReceipt(req.scope, {
      customerId: deposit.customer_id,
      amount: creditedAmount,
      reference,
      merchantTransactionId,
      paymentMethodCode: deposit.payment_method_code,
    });
    await packs.updateGlobePayDeposits({
      selector: { id: deposit.id, status: deposit.status },
      data: {
        status: 'settled',
        gateway_transaction_id:
          gatewayTransactionId || deposit.gateway_transaction_id,
        amount_settled: creditedAmount,
        bank_reference_no:
          typeof data.bankName === 'string' && data.bankName
            ? data.bankName
            : null,
        settled_at: new Date(),
      },
    });
    if (!mutation.replayed) {
      try {
        await notifyFeed(req.scope, {
          receiverId: deposit.customer_id,
          template: 'topup_credited',
          data: { amount_myr: creditedAmount, reference },
          idempotencyKey: topupFeedKey(merchantTransactionId),
        });
      } catch {
        // Feed is best-effort; the credit already landed.
      }
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

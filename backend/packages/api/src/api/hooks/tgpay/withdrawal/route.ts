import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { PACKS_MODULE } from '../../../../modules/packs';
import type PacksModuleService from '../../../../modules/packs/service';
import {
  tgpayCallbackAuthorized,
  tgpayConfigFromEnv,
  tgpayPayoutState,
} from '../../../../modules/packs/tgpay-client';
import { refundGlobePayWithdrawal } from '../../../../modules/packs/globepay-withdrawal';
import { toOptionalMoney } from '../../../../modules/packs/money';
import { notifyFeed } from '../../../../modules/packs/notify-feed';
import { withdrawalFeedKey } from '../../../../modules/packs/feed-events';
import { sendWithdrawalReceipt } from '../../../../modules/packs/withdrawal-receipt';

// TGPay payout server-notify (docs "Payout callback"). Flat body, no wrapper,
// and — unlike every other message — NO merchantRefNum: the row is found by
// the transactionRefNum we stored at create time. Same transitions as the
// GlobePay withdrawal hook; the refund path is the shared helper the sweep and
// the admin deny route already use.

type PayoutNotify = {
  transactionId?: unknown;
  status?: unknown;
  amount?: unknown;
  fee?: unknown;
  paymentAt?: unknown;
  orderno?: unknown;
  payType?: unknown;
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
      '[tgpay] rejected withdrawal callback: key headers missing or wrong',
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
    logger.warn('[tgpay] rejected withdrawal callback: no transactionId');
    res.status(400).send('rejected');
    return;
  }
  const state = tgpayPayoutState(String(data.status ?? ''));

  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const [withdrawal] = await packs.listGlobePayWithdrawals(
    { gateway_transaction_id: gatewayTransactionId },
    { take: 1 },
  );
  if (!withdrawal) {
    logger.error(
      `[tgpay] verified withdrawal callback for UNKNOWN payout ${gatewayTransactionId} (status ${String(data.status)}) — nothing changed`,
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
        `[tgpay] withdrawal ${merchantTransactionId} callback says ${String(data.status)} (${state}) but the row is already ${withdrawal.status} — possible double payment, investigate (gateway ${gatewayTransactionId})`,
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
      await refundGlobePayWithdrawal(
        req.scope,
        withdrawal,
        null,
        'pending',
        `callback ${String(data.status)} at ${String(data.paymentAt ?? '')}`,
      );
    } catch (error) {
      logger.error(
        `[tgpay] failed to refund withdrawal ${merchantTransactionId}: ${(error as Error).message}`,
      );
      res.status(500).send('error');
      return;
    }
    res.status(200).send('success');
    return;
  }

  if (Number(data.amount) !== Number(withdrawal.amount)) {
    logger.error(
      `[tgpay] withdrawal ${merchantTransactionId} settled at ${String(data.amount)}, but ${withdrawal.amount} was debited — investigate before adjusting`,
    );
  }

  await sendWithdrawalReceipt(req.scope, {
    customerId: withdrawal.customer_id,
    amount: Number(withdrawal.amount),
    reference: gatewayTransactionId,
    merchantTransactionId,
    outcome: 'paid',
  });
  await packs.updateGlobePayWithdrawals({
    selector: { id: withdrawal.id, status: 'pending' },
    data: {
      status: 'settled',
      amount_settled: toOptionalMoney(data.amount),
      net_amount: toOptionalMoney(data.amount),
      settled_at: new Date(),
    },
  });

  try {
    await notifyFeed(req.scope, {
      receiverId: withdrawal.customer_id,
      template: 'withdrawal_paid',
      data: {
        amount_myr: Number(withdrawal.amount),
        reference: gatewayTransactionId,
      },
      idempotencyKey: withdrawalFeedKey(merchantTransactionId, 'paid'),
    });
  } catch {
    // Feed is best-effort; the row is already settled.
  }

  res.status(200).send('success');
}

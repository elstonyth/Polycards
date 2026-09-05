import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { PACKS_MODULE } from '../../../../modules/packs';
import type PacksModuleService from '../../../../modules/packs/service';
import {
  withdrawalState,
  openCallback,
} from '../../../../modules/packs/globepay';
import { globepayConfigFromEnv } from '../../../../modules/packs/globepay-client';
import {
  formatGatewayFailureReason,
  withdrawalRefundReference,
} from '../../../../modules/packs/globepay-withdrawal';
import { toOptionalMoney } from '../../../../modules/packs/money';
import { notifyFeed } from '../../../../modules/packs/notify-feed';
import { withdrawalFeedKey } from '../../../../modules/packs/feed-events';
import { sendWithdrawalReceipt } from '../../../../modules/packs/withdrawal-receipt';

// POST /hooks/globepay/withdrawal — GlobePay365 server-to-server payout
// callback (§1.6). The deposit hook's mirror with the money flow inverted:
// the ledger debit already happened at submit time, so
//   status 4 (success) -> mark settled, ledger untouched
//   status 5 (fail)    -> REFUND the debit (idempotent), mark failed
//   anything else      -> processing; ack and wait
//
// Same auth model as deposits: the RSA signature over the AES payload IS the
// authentication; every unsigned envelope field is display-only. Same ack
// contract: literal "success" only for verified AND durably handled.
type WithdrawalCallbackBody = {
  TransactionId?: string;
  MerchantTransactionId?: string;
  Data?: string;
  AdditionalInformationData?: string;
  Signature?: string;
  Version?: number;
};

type WithdrawalCallbackData = {
  MerchantCode: string;
  CurrencyCode: string;
  MerchantTransactionId: string;
  Status: number;
  Amount: number;
  NetAmount: number;
  Remark?: string;
  PaymentMethodCode?: string;
  BankReferenceNo?: string | null;
  UniqueReferenceNo?: string | null;
};

export async function POST(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const body = (req.body ?? {}) as WithdrawalCallbackBody;
  const config = globepayConfigFromEnv();

  // 1) Authenticate — signature over the decrypted payload, before any field
  // is trusted.
  let data: WithdrawalCallbackData;
  try {
    if (!body.Data || !body.Signature) {
      throw new Error('callback missing Data or Signature');
    }
    data = openCallback<WithdrawalCallbackData>(
      { Data: body.Data, Signature: body.Signature },
      { aesKey: config.aesKey, publicKey: config.publicKey },
    );
  } catch (error) {
    req.scope
      .resolve('logger')
      .warn(
        `[globepay] rejected withdrawal callback: ${(error as Error).message}`,
      );
    res.status(400).send('rejected');
    return;
  }

  // Only the SIGNED MerchantTransactionId selects a row (see the deposit
  // hook for the full rationale — an unsigned anchor let one captured
  // callback be replayed with varied ids).
  const gatewayTransactionId = body.TransactionId ?? '';
  const merchantTransactionId = data.MerchantTransactionId ?? '';
  if (!merchantTransactionId) {
    req.scope
      .resolve('logger')
      .warn(
        '[globepay] rejected withdrawal callback: signed payload carried no MerchantTransactionId',
      );
    res.status(400).send('rejected');
    return;
  }

  // Same guard as the deposit hook, same reason: the signature proves GlobePay
  // sent this, not that the payout is ours. Checked before the row lookup so a
  // foreign callback can never touch one of our rows. Case-insensitive, because
  // a casing difference is a config nuisance, not an attack.
  if (
    String(data.MerchantCode ?? '').toUpperCase() !==
    config.merchantCode.toUpperCase()
  ) {
    req.scope
      .resolve('logger')
      .error(
        `[globepay] withdrawal callback for ${merchantTransactionId} names merchant ${data.MerchantCode}, expected ${config.merchantCode} — refusing`,
      );
    res.status(400).send('rejected');
    return;
  }
  const state = withdrawalState(data.Status);

  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  // Only a row THIS gateway created: a GlobePay-signed callback naming a
  // TGPay reference reads as unknown, exactly as the TGPay hooks refuse
  // GlobePay rows. Rows from before the gateway column default to globepay.
  const [withdrawal] = await packs.listGlobePayWithdrawals(
    { merchant_transaction_id: merchantTransactionId, gateway: 'globepay' },
    { take: 1 },
  );

  // 2) Unknown reference: not ours (or another environment on the same
  // merchant account). Retrying can never help — ack and log loudly.
  if (!withdrawal) {
    req.scope
      .resolve('logger')
      .error(
        `[globepay] verified withdrawal callback for UNKNOWN payout ${merchantTransactionId} (gateway ${gatewayTransactionId}, status ${data.Status}) — nothing changed`,
      );
    res.status(200).send('success');
    return;
  }

  // 3) Already resolved — a late duplicate must not flip a settled payout or
  // re-refund a failed one. The refund anchor below is the real guarantee;
  // this keeps the row honest. A FINAL status that CONTRADICTS the stored
  // outcome (their "paid" landing on a row we refunded, or their "failed" on
  // one we settled) is the smoking gun of a double payment — never acted on,
  // always logged loudly.
  if (withdrawal.status !== 'pending') {
    const contradicts =
      (state === 'success' && withdrawal.status !== 'settled') ||
      (state === 'failed' && withdrawal.status !== 'failed');
    if (contradicts) {
      req.scope
        .resolve('logger')
        .error(
          `[globepay] withdrawal ${merchantTransactionId} callback says status ${data.Status} (${state}) but the row is already ${withdrawal.status} — possible double payment, investigate (gateway ${gatewayTransactionId})`,
        );
    }
    res.status(200).send('success');
    return;
  }

  // 4) Non-final: still processing on their side. Ack and wait for the next
  // callback (or the reconcile sweep).
  if (state === 'pending') {
    res.status(200).send('success');
    return;
  }

  // The payout currency must match the ledger currency — same guard as
  // deposits, protecting against account reconfiguration, not attackers
  // (CurrencyCode is signed).
  if (data.CurrencyCode !== config.currencyCode) {
    req.scope
      .resolve('logger')
      .error(
        `[globepay] withdrawal callback for ${merchantTransactionId} is ${data.CurrencyCode}, expected ${config.currencyCode} — refusing to process`,
      );
    res.status(400).send('rejected');
    return;
  }

  if (state === 'failed') {
    // 5) Failed payout: give the money back. Idempotent on the refund anchor,
    // so this callback retried N times — or racing the reconcile sweep —
    // appends exactly one refund.
    try {
      const refund = await packs.withdrawCreditsWithLedger({
        customerId: withdrawal.customer_id,
        amount: Number(withdrawal.amount),
        reason: 'cashout',
        reference: gatewayTransactionId || merchantTransactionId,
        idempotencyReference: withdrawalRefundReference(
          withdrawal.customer_id,
          merchantTransactionId,
        ),
        ledger: {
          outcome: 'refunded',
          bankCode: withdrawal.bank_code,
          accountNumber: withdrawal.account_number,
          gatewayRef: gatewayTransactionId || merchantTransactionId,
        },
      });

      // The emailed record — BEFORE the terminal row update, and outside any
      // !replayed guard: once the row leaves 'pending', a retried callback
      // early-returns and the sweep no longer selects it, so a crash between
      // the update and a later send would lose the email forever. Sending
      // here, a crash before the update re-enters this branch on retry (the
      // refund replays, the notification module's unique idempotency_key
      // dedupes the email), and the send itself never throws.
      await sendWithdrawalReceipt(req.scope, {
        customerId: withdrawal.customer_id,
        amount: Number(withdrawal.amount),
        reference: gatewayTransactionId || merchantTransactionId,
        merchantTransactionId,
        outcome: 'refunded',
      });

      await packs.updateGlobePayWithdrawals({
        selector: { id: withdrawal.id, status: 'pending' },
        data: {
          status: 'failed',
          gateway_status: data.Status,
          gateway_transaction_id:
            gatewayTransactionId || withdrawal.gateway_transaction_id,
          // The gateway's own reason text for the bank-side refusal — the
          // ordinary path for a bank declining a transfer. Without this the
          // row lands in the admin queue reasonless, exactly the blank-reason
          // state PR #433 exists to abolish. Redacted the same way the submit
          // refusal path is: their Remark can echo the account number back.
          failure_reason: formatGatewayFailureReason({
            prefix: 'callback failed',
            codes: [],
            httpStatus: 0,
            bankCode: withdrawal.bank_code,
            message: data.Remark ?? '',
            accountNumber: withdrawal.account_number,
            accountHolderName: withdrawal.account_holder_name,
          }),
        },
      });

      if (!refund.replayed) {
        try {
          await notifyFeed(req.scope, {
            receiverId: withdrawal.customer_id,
            template: 'withdrawal_refunded',
            data: {
              amount_myr: Number(withdrawal.amount),
              reference: gatewayTransactionId || merchantTransactionId,
            },
            idempotencyKey: withdrawalFeedKey(merchantTransactionId, 'refunded'),
          });
        } catch {
          // Never fail a committed refund over a notification.
        }
      }
    } catch (error) {
      // Transient: do NOT ack — the customer's refund must land on retry.
      req.scope
        .resolve('logger')
        .error(
          `[globepay] failed to refund withdrawal ${merchantTransactionId}: ${(error as Error).message}`,
        );
      res.status(500).send('error');
      return;
    }
    res.status(200).send('success');
    return;
  }

  // 6) Success: the money left the merchant balance and reached the bank. The
  // ledger debit already exists — this only closes the row. If their settled
  // Amount disagrees with what we instructed, log loudly; never silently
  // adjust a ledger row that was priced at submit time.
  if (Number(data.Amount) !== Number(withdrawal.amount)) {
    req.scope
      .resolve('logger')
      .error(
        `[globepay] withdrawal ${merchantTransactionId} settled at ${data.Amount}, but ${withdrawal.amount} was debited — investigate before adjusting`,
      );
  }

  // The emailed record — BEFORE the terminal row update: once the row is
  // 'settled', a retried callback early-returns and the sweep skips it, so a
  // crash between the update and a later send would lose the email forever.
  // A crash after this send re-enters this branch on retry and the
  // notification module's unique idempotency_key dedupes. Non-throwing.
  await sendWithdrawalReceipt(req.scope, {
    customerId: withdrawal.customer_id,
    amount: Number(withdrawal.amount),
    reference: gatewayTransactionId || merchantTransactionId,
    merchantTransactionId,
    outcome: 'paid',
  });

  await packs.updateGlobePayWithdrawals({
    selector: { id: withdrawal.id, status: 'pending' },
    data: {
      status: 'settled',
      gateway_status: data.Status,
      gateway_transaction_id:
        gatewayTransactionId || withdrawal.gateway_transaction_id,
      // The settlement facts from the SIGNED payload, previously logged (the
      // Amount disagreement above) or dropped entirely (NetAmount, the bank
      // references) — audit 2026-08-17 B1/B2/C2. amount_settled is what THEY
      // say they paid; the ledger debit stays priced at submit time and is
      // never retro-adjusted, so a disagreement is now durably visible on the
      // row instead of dying with the deployment's logs. NULL means unknown,
      // never zero.
      amount_settled: toOptionalMoney(data.Amount),
      net_amount: toOptionalMoney(data.NetAmount),
      bank_reference_no: data.BankReferenceNo || null,
      unique_reference_no: data.UniqueReferenceNo || null,
      settled_at: new Date(),
    },
  });

  try {
    await notifyFeed(req.scope, {
      receiverId: withdrawal.customer_id,
      template: 'withdrawal_paid',
      data: {
        amount_myr: Number(withdrawal.amount),
        reference: gatewayTransactionId || merchantTransactionId,
      },
      idempotencyKey: withdrawalFeedKey(merchantTransactionId, 'paid'),
    });
  } catch {
    // Never fail a committed settle over a notification.
  }

  res.status(200).send('success');
}

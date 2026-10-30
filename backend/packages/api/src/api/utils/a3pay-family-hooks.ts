import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { ContainerRegistrationKeys } from '@medusajs/framework/utils';
import {
  resolvePacks,
  type GatewayDeposits,
  type GatewayWithdrawals,
} from '../../modules/packs/facets';
import { signatureMismatchAlert } from './a3pay-signature-alert';
import {
  openCallback,
  payinState,
  payoutState,
} from '../../modules/packs/a3pay';
import {
  A3PAY_FAMILY,
  a3payFamilyConfigFromEnv,
  type A3payConfig,
  type A3payKind,
} from '../../modules/packs/a3pay-client';
import { GATEWAYS, rowGateway } from '../../modules/packs/gateway';
import {
  alertPayinVerifyFail,
  applyDepositOutcome,
  isPayinVerifyFail,
} from '../../modules/packs/gateway-deposit';
import {
  applyWithdrawalOutcome,
  redactPayoutText,
  refundWithdrawal,
} from '../../modules/packs/gateway-withdrawal';
import {
  stampNote,
  withdrawalAuditNote,
} from '../../modules/packs/gateway-audit';
import { toOptionalMoney } from '../../modules/packs/money';
import { alertOps } from '../../modules/packs/ops-alert';
import {
  callbackLedgerAmount,
  rowFx,
  toLedgerAmount,
} from '../../modules/packs/payment-fx';

// The inbound handlers for every tenant of the A3Pay platform we hold an
// account with (A3Pay SGD, GlobePay365 USDT): one wire format, so one
// implementation, bound per gateway by src/api/hooks/<kind>/*/route.ts. The
// kind picks the keys that authenticate the message, the rows it may touch,
// and the log prefix — exactly as tgpay-family-hooks.ts does for TGPay.

type Logger = { warn: (m: string) => void; error: (m: string) => void };
type Handler = (req: MedusaRequest, res: MedusaResponse) => Promise<void>;

// A3Pay payin callback (handbook "Payin Callback"). Authenticated by the RSA
// signature over the DECRYPTED Data — nothing in the body is read for money
// before openCallback has verified it, and the reference comes from the SIGNED
// Data, never from the envelope beside it. Answer "success" and they stop
// resending. Idempotent: delivery is at least once.
//
// Amounts arrive in SGD and are converted to RM through the ROW's locked quote
// (payment-fx.ts), so the amount fence in applyDepositOutcome compares RM with
// RM exactly as it does for the RM gateway.

type PayinEnvelope = {
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

/** The payin callback for one tenant; bound by src/api/hooks/<kind>/deposit. */
export function a3payDepositCallback(kind: A3payKind): Handler {
  const tag = `[${kind}]`;
  const { label } = A3PAY_FAMILY[kind];
  return async (req, res) => {
    const logger = req.scope.resolve<Logger>('logger');
    let config: A3payConfig;
    try {
      config = a3payFamilyConfigFromEnv(kind);
    } catch (error) {
      // Not configured on this deploy. 503, so the gateway retries once it is,
      // rather than an unhandled 500 with a stack in the logs.
      logger.error(
        `${tag} deposit callback arrived but ${label} is not configured: ${(error as Error).message}`,
      );
      res.status(503).send('unavailable');
      return;
    }
    const body = (req.body ?? {}) as PayinEnvelope;

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
        `${tag} rejected deposit callback: ${(error as Error).message}`,
      );
      signatureMismatchAlert(
        req.scope,
        error,
        'deposit callback',
        kind,
        config,
      );
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
        `${tag} deposit callback refused: merchant ${data.MerchantCode} / currency ${data.CurrencyCode} / ref ${merchantTransactionId || 'none'} does not match ${config.merchantCode}/${config.currencyCode}`,
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
        `${tag} verified callback for UNKNOWN deposit ${merchantTransactionId} (status ${String(data.Status)}) — nothing credited`,
      );
      res.status(200).send('success');
      return;
    }
    // A tenant's signed callback may only ever touch that tenant's row.
    if (rowGateway(deposit) !== kind) {
      logger.error(
        `${tag} callback names deposit ${merchantTransactionId}, which belongs to gateway "${deposit.gateway}" — ignored`,
      );
      res.status(200).send('success');
      return;
    }

    // Their id: the one CreatePayin returned (stored on the row) wins; the
    // envelope's copy is unsigned, so it is only ever a fallback label.
    const gatewayTransactionId =
      deposit.gateway_transaction_id ||
      (typeof body.TransactionId === 'string' ? body.TransactionId : '');

    // Verify Fail: the customer may have paid from an account in another
    // name. Reported whatever the row says (a late one after the sweep wrote
    // the row off matters most), unless it was credited after all.
    if (isPayinVerifyFail(kind, data.Status) && deposit.status !== 'settled') {
      alertPayinVerifyFail(req.scope, deposit);
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
          `${tag} deposit ${merchantTransactionId} callback says ${String(data.Status)} (${state}) but the row is already ${deposit.status}` +
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
    const creditedAmount = callbackLedgerAmount(
      fx,
      paid,
      GATEWAYS[kind].payinNudgeCents,
    );
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
          `${tag} settled callback for ${merchantTransactionId} claims ${config.currencyCode} ${String(data.Amount)} (RM ${creditedAmount}) but the row asked for ${config.currencyCode} ${String(deposit.gateway_amount)} (RM ${Number(deposit.amount_requested)}) — refusing to credit; the row remains ${deposit.status} for the sweep`,
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

// A3Pay payout callback (handbook "Payout Callback"). Same authentication as
// the deposit hook: decrypt, verify the signature, then read only the signed
// Data. Same transitions as the TGPay payout hook — the refund and the settle
// are the helpers the sweep and the admin routes share. Amounts are SGD and
// are converted to RM through the row's locked quote before they are stored.

type PayoutEnvelope = {
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

/** The payout callback for one tenant; bound by src/api/hooks/<kind>/withdrawal. */
export function a3payWithdrawalCallback(kind: A3payKind): Handler {
  const tag = `[${kind}]`;
  const { label } = A3PAY_FAMILY[kind];
  return async (req, res) => {
    const logger = req.scope.resolve<Logger>('logger');
    let config: A3payConfig;
    try {
      config = a3payFamilyConfigFromEnv(kind);
    } catch (error) {
      // Not configured on this deploy. 503, so the gateway retries once it is,
      // rather than an unhandled 500 with a stack in the logs.
      logger.error(
        `${tag} withdrawal callback arrived but ${label} is not configured: ${(error as Error).message}`,
      );
      res.status(503).send('unavailable');
      return;
    }
    const body = (req.body ?? {}) as PayoutEnvelope;

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
        `${tag} rejected withdrawal callback: ${(error as Error).message}`,
      );
      signatureMismatchAlert(
        req.scope,
        error,
        'withdrawal callback',
        kind,
        config,
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
        `${tag} withdrawal callback refused: merchant ${data.MerchantCode} / currency ${data.CurrencyCode} / ref ${merchantTransactionId || 'none'} does not match ${config.merchantCode}/${config.currencyCode}`,
      );
      res.status(400).send('rejected');
      return;
    }
    const state = payoutState(data.Status);

    const packs = resolvePacks<GatewayWithdrawals>(req.scope);
    const [withdrawal] = await packs.listGatewayWithdrawals(
      { merchant_transaction_id: merchantTransactionId, gateway: kind },
      { take: 1 },
    );
    if (!withdrawal || rowGateway(withdrawal) !== kind) {
      logger.error(
        `${tag} verified withdrawal callback for UNKNOWN payout ${merchantTransactionId} (status ${String(data.Status)}) — nothing changed; the sweep will requery`,
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
          `${tag} withdrawal ${merchantTransactionId} callback says ${String(data.Status)} (${state}) but the row is already ${withdrawal.status} — possible double payment, investigate (gateway ${gatewayTransactionId})`,
        );
        void alertOps(
          req.scope,
          'payout-contradiction',
          `${label} says payout ${merchantTransactionId} is ${state}, but our row is already ${withdrawal.status}` +
            (state === 'success'
              ? ' — the customer may have been refunded AND paid.'
              : '.') +
            ` Investigate ${label} ${gatewayTransactionId}.`,
        );
        // On the row too, as the TGPay hook does, so Settlement and the
        // Dashboard show it at once. In RM at the row's locked rate, the
        // audit's own unit. Best-effort: the gateway still gets its answer.
        try {
          const paid = toLedgerAmount(rowFx(withdrawal), Number(data.Amount));
          await packs.updateGatewayWithdrawals({
            id: withdrawal.id,
            audited_at: new Date(),
            ...stampNote(
              withdrawal,
              withdrawalAuditNote(
                {
                  status: withdrawal.status,
                  amount: toOptionalMoney(withdrawal.amount),
                },
                {
                  kind: 'detail',
                  state,
                  amount: Number.isFinite(paid)
                    ? paid
                    : Number(withdrawal.amount),
                },
              ),
            ),
          });
        } catch (error) {
          logger.error(
            `${tag} could not record the contradiction on ${merchantTransactionId}: ${(error as Error).message}`,
          );
        }
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
          // Free text a gateway operator typed: it can echo the account number
          // or holder name, and this column renders on the admin list.
          `callback status ${String(data.Status)}: ${redactPayoutText(String(data.Remark ?? ''), withdrawal.account_number, withdrawal.account_holder_name ?? '').slice(0, 200)}`,
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

    if (
      Math.round(Number(data.Amount) * 100) !==
      Math.round(Number(withdrawal.gateway_amount) * 100)
    ) {
      const note = `${label} settled payout ${merchantTransactionId} at ${config.currencyCode} ${String(data.Amount)}, but ${config.currencyCode} ${String(withdrawal.gateway_amount)} was submitted (RM ${withdrawal.amount} debited) — investigate before adjusting.`;
      logger.error(`${tag} ${note}`);
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
  };
}

// POST /hooks/a3pay/payout-verify — A3Pay Payout Verification. Before paying
// out they POST the payout here; a literal "success" lets it proceed and
// ANYTHING else rejects it on the spot.
//
// DORMANT for A3Pay: they told us on 2026-10-13 that they do not offer Payout
// Verification for our merchant, so nothing calls /hooks/a3pay/payout-verify
// and verify_outcome stays NULL. Kept in case a tenant turns it on later.
//
// A free second factor on the money-out path: even a request that somehow
// reached SubmitPayout with our signature only pays if it matches a pending
// row WE recorded — same reference, same SGD amount we locked, same currency.
// Rejecting a legitimate payout is recoverable (their fail callback refunds
// it); approving an illegitimate one is not.
//
// Unlike the callbacks, the verification Data carries no MerchantCode (the
// handbook lists MerchantTransactionId, Amount, CurrencyCode only), and the
// envelope's MerchantCode is unsigned — so the merchant is not checked here;
// the row match is the gate. A payload that DOES carry one must match.

type VerifyEnvelope = { Data?: unknown; Signature?: unknown };

type VerifyData = {
  MerchantCode?: string;
  MerchantTransactionId?: string;
  Amount?: number | string;
  CurrencyCode?: string;
};

/**
 * Breadcrumb on the row: that a verification arrived and how we answered.
 * NULL after a failed payout means their call never reached us — a URL or
 * reachability fault no reading of our own logic would reveal. Raw SQL so it
 * does not move updated_at, which the payout sweep reads as the submit clock.
 * Best effort: a throw here must never turn an answer into a 500.
 */
async function recordVerifyOutcome(
  scope: MedusaRequest['scope'],
  rowId: string | null,
  outcome: string,
  tag: string,
): Promise<void> {
  if (!rowId) return;
  try {
    const pg = scope.resolve(ContainerRegistrationKeys.PG_CONNECTION) as {
      raw: (sql: string, bindings: unknown[]) => Promise<unknown>;
    };
    await pg.raw(
      'UPDATE gateway_withdrawal SET verify_outcome = ? WHERE id = ? AND deleted_at IS NULL',
      [`${new Date().toISOString()} ${outcome.slice(0, 400)}`, rowId],
    );
  } catch (error) {
    try {
      scope
        .resolve<Logger>('logger')
        .warn(
          `${tag} could not record verify outcome: ${(error as Error).message}`,
        );
    } catch {
      // nothing left to report with
    }
  }
}

/** Payout Verification for one tenant; bound by src/api/hooks/<kind>/payout-verify. */
export function a3payPayoutVerify(kind: A3payKind): Handler {
  const tag = `[${kind}]`;
  const { label } = A3PAY_FAMILY[kind];
  return async (req, res) => {
    const logger = req.scope.resolve<Logger>('logger');
    let config: A3payConfig;
    try {
      config = a3payFamilyConfigFromEnv(kind);
    } catch (error) {
      // Not configured on this deploy. 503, so the gateway retries once it is,
      // rather than an unhandled 500 with a stack in the logs.
      logger.error(
        `${tag} payout verification arrived but ${label} is not configured: ${(error as Error).message}`,
      );
      res.status(503).send('unavailable');
      return;
    }
    const body = (req.body ?? {}) as VerifyEnvelope;

    let data: VerifyData;
    try {
      if (typeof body.Data !== 'string' || typeof body.Signature !== 'string') {
        throw new Error('missing Data or Signature');
      }
      data = openCallback<VerifyData>(
        { Data: body.Data, Signature: body.Signature },
        config,
      );
    } catch (error) {
      logger.warn(
        `${tag} rejected payout verification: ${(error as Error).message}`,
      );
      signatureMismatchAlert(
        req.scope,
        error,
        'payout verification',
        kind,
        config,
      );
      res.status(400).send('rejected');
      return;
    }

    const merchantTransactionId = String(data.MerchantTransactionId ?? '');
    const packs = resolvePacks<GatewayWithdrawals>(req.scope);
    const [withdrawal] = merchantTransactionId
      ? await packs.listGatewayWithdrawals(
          { merchant_transaction_id: merchantTransactionId, gateway: kind },
          { take: 1 },
        )
      : [];

    // One refusal, one reason — the recorded reason is the point of the column.
    const refusal =
      data.MerchantCode !== undefined &&
      String(data.MerchantCode).toUpperCase() !==
        config.merchantCode.toUpperCase()
        ? `names merchant ${data.MerchantCode}, expected ${config.merchantCode}`
        : !withdrawal
          ? 'no such withdrawal row'
          : withdrawal.status !== 'pending'
            ? `row status is ${withdrawal.status}`
            : withdrawal.gateway_amount == null
              ? `row carries no locked ${config.currencyCode} amount`
              : Math.round(Number(data.Amount) * 100) !==
                  Math.round(Number(withdrawal.gateway_amount) * 100)
                ? `amount ${data.Amount} != locked ${withdrawal.gateway_amount}`
                : String(data.CurrencyCode ?? '').toUpperCase() !==
                    config.currencyCode.toUpperCase()
                  ? `currency ${data.CurrencyCode} != ${config.currencyCode}`
                  : null;

    if (refusal) {
      logger.error(
        `${tag} payout verification REFUSED for ${merchantTransactionId || 'unknown'}: ${refusal}`,
      );
      await recordVerifyOutcome(
        req.scope,
        withdrawal?.id ?? null,
        `rejected: ${refusal}`,
        tag,
      );
      res.status(400).send('rejected');
      return;
    }

    await recordVerifyOutcome(req.scope, withdrawal!.id, 'success', tag);
    res.status(200).send('success');
  };
}

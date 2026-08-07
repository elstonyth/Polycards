import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { PACKS_MODULE } from '../../../../modules/packs';
import type PacksModuleService from '../../../../modules/packs/service';
import { depositState, openCallback } from '../../../../modules/packs/globepay';
import { globepayConfigFromEnv } from '../../../../modules/packs/globepay-client';
import { GLOBEPAY_MAX_RM } from '../../../../modules/packs/globepay-deposit';
import { topupIdempotencyReference } from '../../../../modules/packs/topup';
import { sendTopupReceipt } from '../../../../modules/packs/topup-receipt';
import { notifyFeed } from '../../../../modules/packs/notify-feed';
import { topupFeedKey } from '../../../../modules/packs/feed-events';

// POST /hooks/globepay/deposit — GlobePay365 server-to-server deposit callback
// (§1.2). This is the ONLY path that turns a real payment into site credit.
//
// Deliberately NOT under /store/*: a webhook carries neither a customer session
// nor a publishable API key, so it must sit outside the authenticate() matchers
// in src/api/middlewares.ts. Authentication here is the RSA-SHA1 signature over
// their AES payload — not a header, not the source IP.
//
// ACK CONTRACT (§1.2.1): the literal body "success" stops their retries.
//   - Verified AND durably handled (credited, marked failed, or a no-op we are
//     certain about) -> "success".
//   - Signature/decrypt failure, or a transient error on our side -> non-2xx,
//     so a genuine callback we failed to process gets retried.
// The distinction that matters: a status-7 (failed) deposit is HANDLED, not an
// error. Returning non-2xx for it would make them retry a dead deposit forever.
//
// ONE DELIBERATE EXCEPTION: the three "this callback is wrong about itself"
// guards below — wrong merchant, wrong currency, amount over the deposit
// ceiling — also answer non-2xx, and a retry can never fix any of them. That
// is the point. Each says a payment exists that we refuse to act on, so the
// row must stay claimable and the retries must keep the event visible until a
// human looks. Acking would file it as handled when nothing was handled.
type DepositCallbackBody = {
  TransactionId?: string;
  MerchantTransactionId?: string;
  Data?: string;
  AdditionalInformationData?: string;
  Signature?: string;
  Version?: number;
};

type DepositCallbackData = {
  MerchantCode: string;
  CurrencyCode: string;
  MerchantTransactionId: string;
  Status: number;
  Amount: number;
  NetAmount: number;
  Remark?: string;
  PaymentMethodCode?: string;
  BankReferenceNo?: string;
  UniqueReferenceNo?: string;
};

export async function POST(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const body = (req.body ?? {}) as DepositCallbackBody;
  const config = globepayConfigFromEnv();

  // 1) Authenticate. Verify the signature over the DECRYPTED payload before a
  // single field is trusted — openCallback throws unless it checks out.
  let data: DepositCallbackData;
  try {
    if (!body.Data || !body.Signature) {
      throw new Error('callback missing Data or Signature');
    }
    data = openCallback<DepositCallbackData>(
      { Data: body.Data, Signature: body.Signature },
      { aesKey: config.aesKey, publicKey: config.publicKey },
    );
  } catch (error) {
    // Unverified: NOT "success". Either it is not from them (drop it) or our
    // keys are wrong (we want the retries while that gets fixed).
    req.scope
      .resolve('logger')
      .warn(
        `[globepay] rejected deposit callback: ${(error as Error).message}`,
      );
    res.status(400).send('rejected');
    return;
  }

  // SIGNED vs UNSIGNED — the distinction the whole route depends on.
  //
  // Only `Data` is covered by the signature. Every other top-level field
  // (TransactionId, MerchantTransactionId, Version) is attacker-mutable on an
  // otherwise-genuine body, because changing them does not invalidate anything.
  //
  // So NOTHING security-relevant may be derived from them. In particular the
  // idempotency anchor is built from the SIGNED MerchantTransactionId: anchoring
  // on the unsigned TransactionId would let one captured callback be replayed N
  // times with N different ids, each computing a different anchor, each slipping
  // past the ledger dedupe and minting another credit. It would also double-
  // credit with no attacker at all if the gateway ever varied that id across
  // retries — an assumption we have never been able to verify.
  //
  // TransactionId is kept ONLY as the human-facing reconciliation handle.
  const gatewayTransactionId = body.TransactionId ?? '';
  const merchantTransactionId = data.MerchantTransactionId ?? '';
  if (!merchantTransactionId) {
    // No signed reference means nothing legitimately selects a deposit row —
    // and therefore a customer. Refuse rather than fall back to the unsigned
    // envelope copy.
    req.scope
      .resolve('logger')
      .warn(
        '[globepay] rejected deposit callback: signed payload carried no MerchantTransactionId',
      );
    res.status(400).send('rejected');
    return;
  }

  // The signature says "GlobePay sent this". It does NOT say "this payment is
  // yours" — MerchantCode is the one signed field that does, and until now it
  // was declared and never read. If their callbacks are signed with a
  // platform-wide key rather than a per-merchant one, a payment into someone
  // else's merchant account would verify here.
  //
  // Checked BEFORE the row lookup, not beside the CurrencyCode guard further
  // down: that one sits after the status-7 branch, so a foreign callback whose
  // reference collided with ours would already have written a live deposit off
  // as failed. Case-insensitive — a casing difference between the configured
  // value and what they echo is a config nuisance, not an attack, and a
  // case-sensitive compare would reject legitimate traffic.
  if (
    String(data.MerchantCode ?? '').toUpperCase() !==
    config.merchantCode.toUpperCase()
  ) {
    req.scope
      .resolve('logger')
      .error(
        `[globepay] deposit callback for ${merchantTransactionId} names merchant ${data.MerchantCode}, expected ${config.merchantCode} — refusing`,
      );
    res.status(400).send('rejected');
    return;
  }
  const state = depositState(data.Status);

  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const [deposit] = await packs.listGlobePayDeposits(
    { merchant_transaction_id: merchantTransactionId },
    { take: 1 },
  );

  // 2) Unknown reference. The row is written BEFORE SubmitDeposit is called, so
  // a verified callback with no row cannot be a race — it is a deposit created
  // outside this system (or against another environment sharing the merchant
  // account). Retrying would never produce a row, so ack and log loudly.
  if (!deposit) {
    req.scope
      .resolve('logger')
      .error(
        `[globepay] verified callback for UNKNOWN deposit ${merchantTransactionId} (gateway ${gatewayTransactionId}, status ${data.Status}) — nothing credited`,
      );
    res.status(200).send('success');
    return;
  }

  // 3) Already resolved. A late status-7 arriving after a deposit settled must
  // NOT flip the row to failed while the credit stands — that leaves the record
  // contradicting the ledger. Row-level idempotency, and safe against retries:
  // the transient-error path below leaves the row 'pending', so a callback we
  // genuinely failed to process still gets reprocessed.
  //
  // EXCEPT success-on-a-closed-row, which is money in with no credit. The sweep
  // can close a row (globepay-reconcile.ts: an explicit not-found requery, or a
  // non-final status older than GLOBEPAY_STALE_AFTER_MS), and its live queue is
  // status='pending' — the second scan tier revisits 'expired' rows for a
  // bounded window, but nothing ever requeries a 'failed' one.
  // Before this branch existed, the customer's own
  // settlement callback then arrived here, was acked 200, credited nothing and
  // logged nothing: the payment vanished with the only trace sitting in
  // GlobePay's back office. Recover it instead. Crediting late is safe — the
  // signed-anchor dedupe in mutateCreditAtomic collapses this with any other
  // delivery of the same deposit — whereas swallowing it is not.
  if (deposit.status !== 'pending') {
    // 'expired' as well as 'failed': the sweep now writes 'expired' when it
    // merely stopped chasing a deposit the gateway never ruled on, which is
    // precisely the row a late settlement callback belongs to. Recovering only
    // 'failed' would have re-opened the same hole for the new status.
    const recoverable =
      state === 'success' &&
      (deposit.status === 'failed' || deposit.status === 'expired');
    // Mirrors the withdrawal route's guard: any callback disagreeing with the
    // row we already wrote is worth an operator's attention, recoverable or not.
    // Left as-is for 'expired': a status-7 callback on a row we expired is not
    // a contradiction so much as the answer arriving late, but it DOES leave
    // the row 'expired' (the !recoverable return below skips the flip) until
    // the sweep's second tier requeries it — so the log line is the only trace
    // that happened, and silence would be worse than a slightly loud alert.
    const contradicts =
      (state === 'success' && deposit.status !== 'settled') ||
      (state === 'failed' && deposit.status !== 'failed');
    if (contradicts) {
      req.scope
        .resolve('logger')
        .error(
          `[globepay] deposit ${merchantTransactionId} callback says status ${data.Status} (${state}) but the row is already ${deposit.status} (gateway ${gatewayTransactionId})` +
            (recoverable
              ? ' — crediting a written-off deposit that the customer did pay'
              : ' — investigate'),
        );
    }
    if (!recoverable) {
      res.status(200).send('success');
      return;
    }
    // falls through to the credit path below
  }

  // 4) Non-final states (their status 4 "VerifyFail" among them) are explicitly
  // NOT failures — the deposit can still settle. Acknowledge without touching
  // the ledger; the next callback carries the real outcome.
  if (state === 'pending') {
    res.status(200).send('success');
    return;
  }

  if (state === 'failed') {
    await packs.updateGlobePayDeposits({
      selector: { id: deposit.id, status: 'pending' },
      data: {
        status: 'failed',
        gateway_status: data.Status,
        gateway_transaction_id:
          gatewayTransactionId || deposit.gateway_transaction_id,
      },
    });
    res.status(200).send('success');
    return;
  }

  // 4) Settled. Credit the amount THEY confirmed, not the amount we requested —
  // a customer can pay a different sum than the one the top-up sheet asked for,
  // and the ledger must reflect money actually received.
  //
  // Amount vs NetAmount: CONFIRMED by the provider 2026-07-22 — credit
  // `Amount`; `NetAmount` is that figure minus their fees ("net amount 是减了
  // 费用"). Crediting NetAmount would silently short every customer by the fee.
  // The ledger is Ringgit and credits 1:1. A settled callback in any other
  // currency would silently credit e.g. 500 VND as RM 500. CurrencyCode IS
  // signed, so this is not an attack surface — it is a guard against the
  // account being reconfigured (or another currency enabled) without the
  // ledger being taught the exchange rate.
  if (data.CurrencyCode !== config.currencyCode) {
    req.scope
      .resolve('logger')
      .error(
        `[globepay] settled callback for ${merchantTransactionId} is ${data.CurrencyCode}, expected ${config.currencyCode} — refusing to credit`,
      );
    res.status(400).send('rejected');
    return;
  }

  const creditedAmount = Number(data.Amount);
  if (!Number.isFinite(creditedAmount) || creditedAmount <= 0) {
    req.scope
      .resolve('logger')
      .error(
        `[globepay] settled callback for ${merchantTransactionId} carried a non-positive Amount (${data.Amount}) — refusing to credit`,
      );
    res.status(400).send('rejected');
    return;
  }

  // A CEILING, not an equality check — the decision above stands: a customer
  // may legitimately pay a sum other than the one we asked for. But no callback
  // should confirm more than the submit path could ever have created, and that
  // path refuses anything over GLOBEPAY_MAX_RM (globepay-deposit.ts). The same
  // constant is imported here on purpose: raise it for product reasons and this
  // ceiling follows, so the two can never drift apart. Without it a single
  // validly-signed event with an inflated Amount — a gateway bug, a key
  // compromise, an account reconfiguration — becomes withdrawable cash 1:1,
  // because mutateCreditAtomic's only top-up guard is deltaCents > 0.
  //
  // QUARANTINE, never write off: the row is left untouched (whatever status it
  // had — usually 'pending', but the recovery branch above reaches here with a
  // 'failed' one) and we answer non-2xx so they retry and an operator can
  // settle it by hand. The customer may genuinely have paid; writing the row
  // off here would convert an operator alert into silent money loss.
  if (creditedAmount > GLOBEPAY_MAX_RM) {
    req.scope
      .resolve('logger')
      .error(
        `[globepay] settled callback for ${merchantTransactionId} claims Amount ${creditedAmount}, above the RM ${GLOBEPAY_MAX_RM} deposit ceiling — refusing to credit; the row remains ${deposit.status} for manual settlement`,
      );
    res.status(400).send('rejected');
    return;
  }

  try {
    // Idempotent on the SIGNED MerchantTransactionId (see the note above). Every
    // retry of this deposit — however many, however concurrent, whatever the
    // unsigned TransactionId says — resolves to the same anchor, so the
    // per-customer locked dedupe in mutateCreditAtomic collapses them to one
    // credit. This is what makes the status check below a consistency guard
    // rather than the thing standing between us and a double credit.
    const mutation = await packs.topUpCreditsWithLedger({
      customerId: deposit.customer_id,
      amount: creditedAmount,
      reason: 'topup',
      // The paired TP ledger row lands in the same transaction as the credit.
      // Without it Σ(ledger) would drift from the balance on every real
      // top-up (ledger-conservation.spec).
      ledgerPaymentMethod: deposit.payment_method_code,
      ledgerGatewayRef: gatewayTransactionId || merchantTransactionId,
      // Their id is the reconciliation handle a human quotes in support — it is
      // display-only, and unsigned, so it never gates anything.
      reference: gatewayTransactionId || merchantTransactionId,
      idempotencyReference: topupIdempotencyReference(
        deposit.customer_id,
        merchantTransactionId,
      ),
    });

    // The emailed receipt — after the credit commit, BEFORE the terminal row
    // update, and outside the !replayed guard: once the row is 'settled' a
    // retried callback early-returns and the sweep skips it, so a crash
    // between the update and a later send would lose the email forever. A
    // crash after this send re-enters this branch on retry (the credit
    // replays, the notification module's unique idempotency_key dedupes the
    // email — a second insert throws and sendTopupReceipt swallows it). Its
    // own send is non-throwing; the committed credit is never undone by an
    // email problem.
    await sendTopupReceipt(req.scope, {
      customerId: deposit.customer_id,
      amount: creditedAmount,
      reference: gatewayTransactionId || merchantTransactionId,
      merchantTransactionId,
      paymentMethodCode: deposit.payment_method_code,
    });

    // Conditional flip on the status we READ, not a literal 'pending': the
    // recovery branch above reaches here with a 'failed' row, and a hardcoded
    // 'pending' selector would match nothing — the credit would land while the
    // row stayed 'failed', leaving the ledger and the record disagreeing about
    // the same deposit. Matching deposit.status keeps the concurrency guard
    // intact (a row another worker moved since we read it still no-ops) while
    // letting a written-off deposit be put right.
    await packs.updateGlobePayDeposits({
      selector: { id: deposit.id, status: deposit.status },
      data: {
        status: 'settled',
        gateway_status: data.Status,
        gateway_transaction_id:
          gatewayTransactionId || deposit.gateway_transaction_id,
        amount_settled: creditedAmount,
        settled_at: new Date(),
      },
    });

    // Durable receipt, mirroring the mock top-up path. A replay credited
    // nothing, so it must not produce a second feed row. Non-fatal: the credit
    // is already committed and must not be undone by a notification failure.
    if (!mutation.replayed) {
      try {
        await notifyFeed(req.scope, {
          receiverId: deposit.customer_id,
          template: 'topup_credited',
          data: {
            amount_myr: creditedAmount,
            reference: gatewayTransactionId || merchantTransactionId,
          },
          // Keyed on the SIGNED reference for the same reason as the credit
          // anchor: an unsigned key would let a varied TransactionId produce a
          // second receipt for one payment.
          idempotencyKey: topupFeedKey(merchantTransactionId),
        });
      } catch {
        // Never fail a committed credit over a notification.
      }
    }
  } catch (error) {
    // Transient (DB down, lock timeout): do NOT ack, so they retry and the
    // customer's money still lands.
    req.scope
      .resolve('logger')
      .error(
        `[globepay] failed to credit deposit ${merchantTransactionId}: ${(error as Error).message}`,
      );
    res.status(500).send('error');
    return;
  }

  // AdditionalInformationData is declared on the body type above and
  // deliberately NEVER read. Unlike MerchantCode — which was declared-and-
  // unread as a BUG, because it is the one signed field saying the money is
  // ours — this one is declared-and-unread as the FIX:
  //   - it is UNSIGNED (only `Data` is covered by the signature, per the
  //     SIGNED vs UNSIGNED note above), so its contents are not authenticated;
  //   - it carries the receiving bank details (§1.2.4), and nothing the credit
  //     depends on;
  //   - it used to be decrypted straight into an info log line. Logs have a
  //     wider access population and a longer retention than the database, so
  //     that put customer bank details somewhere they outlive the deposit row —
  //     defeating the minimization the withdrawal ledger applies (it stores
  //     account_last4 only, see modules/packs/service.ts).
  // The field stays on the type to document the wire shape. Do not log it.

  res.status(200).send('success');
}

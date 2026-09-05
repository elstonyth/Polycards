import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { ContainerRegistrationKeys } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../../modules/packs';
import type PacksModuleService from '../../../../modules/packs/service';
import { openCallback } from '../../../../modules/packs/globepay';
import { globepayConfigFromEnv } from '../../../../modules/packs/globepay-client';

// POST /hooks/globepay/payout-verify — GlobePay365 Payout Verification (§1.7).
// Before executing a payout they POST the withdrawal here; a literal "success"
// lets it proceed, ANYTHING else rejects it immediately.
//
// This is a free second factor on the money-out path: even a request that
// somehow reached SubmitWithdrawal with our signature only pays out if it
// matches a pending row WE recorded — same reference, same amount. Currently
// inactive on the staging account, but implemented so switching it on
// provider-side needs no code change.
type PayoutVerifyBody = {
  MerchantCode?: string;
  Data?: string;
  Signature?: string;
  Version?: number;
};

type PayoutVerifyData = {
  MerchantCode: string;
  CurrencyCode: string;
  MerchantTransactionId: string;
  Amount: number;
};

/**
 * Record on the withdrawal row that a verification arrived, and how we
 * answered it (plan 095).
 *
 * Written on EVERY answered invocation, 'success' included. The point is the
 * NULL: their Payout Verification is active on the production merchant, so a
 * payout that failed with `verify_outcome` still null means their call never
 * reached this route — a URL or reachability fault, which no amount of reading
 * our own refusal logic would ever reveal. DigitalOcean only keeps run logs for
 * the current deployment, so the log line this mirrors cannot be relied on the
 * morning after.
 *
 * BEST EFFORT, and deliberately so: this is a note to a future operator, and
 * their verification is on the money path with a timeout at the other end. A
 * throw here must never turn a "success" into a rejected payout, nor a clean
 * rejection into a 500 that they may retry.
 */
async function recordVerifyOutcome(
  scope: MedusaRequest['scope'],
  /** The row when the caller already read it; null makes this look it up. */
  known: { id: string } | null,
  merchantTransactionId: string,
  outcome: string,
): Promise<void> {
  try {
    const packs = scope.resolve<PacksModuleService>(PACKS_MODULE);
    let row = known;
    if (!row) {
      [row] = await packs.listGlobePayWithdrawals(
        { merchant_transaction_id: merchantTransactionId, gateway: 'globepay' },
        { take: 1 },
      );
    }
    if (!row) return;
    // Raw, NOT the generated update: that one stamps updated_at, and the
    // withdrawal sweep reads updated_at as a pending row's SUBMIT clock
    // (globepay-withdrawal-reconcile.ts: "adding a write that leaves a row
    // 'pending' without a gateway id BREAKS this"). A verification landing on
    // an ambiguous submit pushed its not-found refund out by up to an hour per
    // call (review 2026-09). This column is a breadcrumb; it must not move
    // that clock.
    //
    // Truncated: this column is a breadcrumb, not a transcript, and the
    // gateway's own text is the only part we do not compose. The REASON is
    // what gets cut, never the timestamp in front of it — slicing the joined
    // string would spend the budget on a fixed 24-char prefix and could, on
    // a long enough gateway message, leave a row stamped with a time and
    // half a word.
    const pg = scope.resolve(ContainerRegistrationKeys.PG_CONNECTION);
    await pg.raw(
      'UPDATE globepay_withdrawal SET verify_outcome = ? WHERE id = ? AND deleted_at IS NULL',
      [`${new Date().toISOString()} ${outcome.slice(0, 400)}`, row.id],
    );
  } catch (error) {
    // Swallowed for the money path's sake — see the doc comment — but not
    // silently. A recorder that fails on an APPROVED verification leaves a row
    // that looks like it was never verified at all, which is the one reading
    // this column exists to make trustworthy. Best-effort again: the logger is
    // the last thing left, so a throw from it has nowhere to go.
    try {
      scope
        .resolve<{ warn: (message: string) => void }>('logger')
        .warn(
          `[globepay] could not record verify outcome for ${merchantTransactionId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
    } catch {
      // Nothing left to report with.
    }
  }
}

export async function POST(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const body = (req.body ?? {}) as PayoutVerifyBody;
  const config = globepayConfigFromEnv();

  let data: PayoutVerifyData;
  try {
    if (!body.Data || !body.Signature) {
      throw new Error('verification missing Data or Signature');
    }
    data = openCallback<PayoutVerifyData>(
      { Data: body.Data, Signature: body.Signature },
      { aesKey: config.aesKey, publicKey: config.publicKey },
    );
  } catch (error) {
    req.scope
      .resolve('logger')
      .warn(
        `[globepay] rejected payout verification: ${(error as Error).message}`,
      );
    res.status(400).send('rejected');
    return;
  }

  // Same guard as the two callback hooks: the signature proves GlobePay sent
  // this, not that the payout is ours. Note it reads data.MerchantCode, the
  // SIGNED copy — PayoutVerifyBody declares an envelope MerchantCode too, and
  // that one is attacker-mutable, so checking it would guard nothing.
  // Case-insensitive, because a casing difference is a config nuisance.
  if (
    String(data.MerchantCode ?? '').toUpperCase() !==
    config.merchantCode.toUpperCase()
  ) {
    req.scope
      .resolve('logger')
      .error(
        `[globepay] payout verification REFUSED for ${data.MerchantTransactionId}: names merchant ${data.MerchantCode}, expected ${config.merchantCode}`,
      );
    // Recorded even here: the payload is past `openCallback`, so its signature
    // is GlobePay's own — a forged reference cannot reach this line and stamp
    // someone else's row.
    await recordVerifyOutcome(
      req.scope,
      null,
      data.MerchantTransactionId ?? '',
      `rejected: names merchant ${data.MerchantCode}, expected ${config.merchantCode}`,
    );
    res.status(400).send('rejected');
    return;
  }

  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  // Only a row THIS gateway created (see the deposit hook); a TGPay row
  // named here reads as unknown and is rejected like any other.
  const [withdrawal] = await packs.listGlobePayWithdrawals(
    {
      merchant_transaction_id: data.MerchantTransactionId ?? '',
      gateway: 'globepay',
    },
    { take: 1 },
  );

  // Only a payout we recorded, still in flight, for the exact amount we
  // debited, IN OUR CURRENCY, is allowed to proceed. Everything else is
  // rejected — rejecting a legitimate payout is recoverable (their fail
  // callback refunds it); approving an illegitimate one is not.
  //
  // One refusal, one reason. The four checks used to collapse into a single
  // boolean whose message always blamed the amount, so a currency that did not
  // match reported itself as an amount mismatch — and the recorded reason is
  // the whole point of this route now, not a nicety. The gate itself is
  // unchanged: same four conditions, same rejection.
  const refusal = !withdrawal
    ? 'no such withdrawal row'
    : withdrawal.status !== 'pending'
      ? `row status is ${withdrawal.status}`
      : Number(data.Amount) !== Number(withdrawal.amount)
        ? `amount ${data.Amount} != debited ${withdrawal.amount}`
        : data.CurrencyCode !== config.currencyCode
          ? `currency ${data.CurrencyCode} != ${config.currencyCode}`
          : null;
  if (refusal) {
    req.scope
      .resolve('logger')
      .error(
        `[globepay] payout verification REFUSED for ${data.MerchantTransactionId}: ${refusal}`,
      );
    await recordVerifyOutcome(
      req.scope,
      withdrawal ?? null,
      data.MerchantTransactionId ?? '',
      `rejected: ${refusal}`,
    );
    res.status(400).send('rejected');
    return;
  }

  await recordVerifyOutcome(
    req.scope,
    withdrawal,
    data.MerchantTransactionId ?? '',
    'success',
  );
  res.status(200).send('success');
}

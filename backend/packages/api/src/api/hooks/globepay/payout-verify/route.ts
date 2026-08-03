import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
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

  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const [withdrawal] = await packs.listGlobePayWithdrawals(
    { merchant_transaction_id: data.MerchantTransactionId ?? '' },
    { take: 1 },
  );

  // Only a payout we recorded, still in flight, for the exact amount we
  // debited, IN OUR CURRENCY, is allowed to proceed. Everything else is
  // rejected — rejecting a legitimate payout is recoverable (their fail
  // callback refunds it); approving an illegitimate one is not.
  const amountMatches =
    withdrawal &&
    Number(data.Amount) === Number(withdrawal.amount) &&
    data.CurrencyCode === config.currencyCode;
  if (!withdrawal || withdrawal.status !== 'pending' || !amountMatches) {
    req.scope
      .resolve('logger')
      .error(
        `[globepay] payout verification REFUSED for ${data.MerchantTransactionId}: ` +
          (!withdrawal
            ? 'no such withdrawal row'
            : withdrawal.status !== 'pending'
              ? `row status is ${withdrawal.status}`
              : `amount ${data.Amount} != debited ${withdrawal.amount}`),
      );
    res.status(400).send('rejected');
    return;
  }

  res.status(200).send('success');
}

import { randomUUID } from 'node:crypto';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from './index';
import type PacksModuleService from './service';
import {
  globepayConfigFromEnv,
  submitDeposit,
  GlobePayError,
} from './globepay-client';
import { topUpAmountError } from './topup';

// The submit half of the GlobePay365 deposit loop: record intent, ask the
// gateway for a cashier page, hand the customer the URL. NO credit is issued
// here — that happens only when a verified callback reports status 6
// (src/api/hooks/globepay/deposit/route.ts).

/** Default MYR deposit method. BQR is the only channel provisioned on staging. */
export const GLOBEPAY_DEFAULT_METHOD = 'BQR';

/**
 * The MYR deposit methods (doc "Deposit Method Appendix"). The client sends
 * CurrencyCode: MYR, but PaymentMethodCode comes from the request body — so
 * without this list a caller could ask for a method belonging to another
 * currency (UPI, MOMO, BKASH…) and depend on gateway-side behaviour we cannot
 * see. Allow-list, not deny-list: an unknown code is rejected.
 */
export const GLOBEPAY_MYR_METHODS = ['FPX', 'DN', 'BQR', 'OB'] as const;

/**
 * Is the real gateway switched on? Mirrors mockTopupAllowed's fail-closed
 * shape: absent config means "not configured", never a silent fallback that
 * mints free credit. Pure (env injected) so the policy is unit-testable.
 */
export function globepayEnabled(
  env: {
    GLOBEPAY_ENABLED?: string;
    GLOBEPAY_MERCHANT_CODE?: string;
  } = process.env,
): boolean {
  return env.GLOBEPAY_ENABLED === 'true' && Boolean(env.GLOBEPAY_MERCHANT_CODE);
}

/**
 * Our reference, sent as MerchantTransactionId. Deliberately opaque: it shows
 * up in GlobePay365's back office, so it must NOT carry a customer id (the
 * callback carries this value back, and the globepay_deposit row is what maps
 * it to a customer). Prefixed so a human can spot ours in their listing.
 */
export function newMerchantTransactionId(): string {
  return `PC-${randomUUID().replace(/-/g, '')}`;
}

export type StartDepositInput = {
  /** From the verified token — NEVER the request body. */
  customerId: string;
  /** Raw body value; validated here with the same rules as the mock top-up. */
  amount: unknown;
  /** The CUSTOMER's IP (they require it), not our server's. */
  ipAddress: string;
  paymentMethodCode?: string;
};

export type StartDepositResult = {
  /** Where to send the customer. Always redirect — it renders their errors too. */
  url: string;
  /** Their deposit id, for support/reconciliation. */
  transactionId: string;
  /** Our reference. */
  merchantTransactionId: string;
  amount: number;
  /** Bank/QR details for methods that render in-page instead of redirecting. */
  bankCode?: string | null;
  accountNumber?: string | null;
  accountHolderName?: string | null;
  referenceNo?: string | null;
  qrCode?: string | null;
};

/**
 * Create a deposit. The row is written BEFORE the gateway call so a callback
 * can never arrive for a reference we have no record of — their callback echoes
 * MerchantTransactionId but not MerchantClientId, so that row is the only way
 * back to a customer.
 */
export async function startGlobePayDeposit(
  scope: { resolve: <T>(key: string) => T },
  input: StartDepositInput,
  notifyUrl: string,
  returnUrl: string,
): Promise<StartDepositResult> {
  if (!globepayEnabled()) {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      'Top-ups are temporarily unavailable.',
    );
  }

  const invalid = topUpAmountError(input.amount);
  if (invalid) {
    throw new MedusaError(MedusaError.Types.INVALID_DATA, invalid);
  }
  const amount = input.amount as number;

  const paymentMethodCode = input.paymentMethodCode ?? GLOBEPAY_DEFAULT_METHOD;
  if (
    !(GLOBEPAY_MYR_METHODS as readonly string[]).includes(paymentMethodCode)
  ) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'Unsupported payment method.',
    );
  }

  const config = globepayConfigFromEnv();
  const packs = scope.resolve<PacksModuleService>(PACKS_MODULE);
  const merchantTransactionId = newMerchantTransactionId();

  const [row] = await packs.createGlobePayDeposits([
    {
      merchant_transaction_id: merchantTransactionId,
      customer_id: input.customerId,
      amount_requested: amount,
      payment_method_code: paymentMethodCode,
      status: 'pending',
    },
  ]);

  let result;
  try {
    result = await submitDeposit(
      {
        merchantTransactionId,
        // Their support/reconciliation view. Our customer id is already opaque
        // and is not usable to reach the account, unlike an email.
        merchantClientId: input.customerId,
        amount,
        notifyUrl,
        returnUrl,
        ipAddress: input.ipAddress,
        paymentMethodCode,
      },
      config,
    );
  } catch (error) {
    // The gateway refused, so no deposit exists on their side and no callback
    // will ever arrive. Close the row out rather than leaving it pending and
    // polluting the reconciliation sweep forever.
    await packs.updateGlobePayDeposits({ id: row.id, status: 'failed' });
    if (error instanceof GlobePayError) {
      // Their validation errors are the customer's problem to fix (amount out
      // of range, method unavailable), not a 500.
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        'We could not start your top-up. Please try a different amount or payment method.',
      );
    }
    throw error;
  }

  await packs.updateGlobePayDeposits({
    id: row.id,
    gateway_transaction_id: result.transactionId,
  });

  return {
    url: result.url,
    transactionId: result.transactionId,
    merchantTransactionId,
    amount,
    bankCode: result.bankCode,
    accountNumber: result.accountNumber,
    accountHolderName: result.accountHolderName,
    referenceNo: result.referenceNo,
    qrCode: result.qrCode,
  };
}

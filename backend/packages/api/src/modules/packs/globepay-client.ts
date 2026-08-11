import {
  buildEnvelope,
  depositState,
  withdrawalState,
  type SettlementState,
} from './globepay';

// GlobePay365 HTTP client. Thin: build envelope, POST JSON, unwrap their
// { isSuccess, errorList, data } response shape. The wire format itself lives
// in globepay.ts; this file only knows endpoints and error handling.

export type GlobePayConfig = {
  baseUrl: string;
  merchantCode: string;
  aesKey: string;
  privateKey: string;
  /** Their public key — only needed to verify callbacks, not to call out. */
  publicKey: string;
  currencyCode: string;
};

/**
 * Read config from env, failing loudly on a missing value. A half-configured
 * gateway must not start: the failure mode is silently signing with an empty
 * key and getting an opaque rejection hours later.
 */
export function globepayConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): GlobePayConfig {
  const required = (name: string): string => {
    const value = env[name];
    if (!value) {
      throw new Error(`GlobePay365: missing required env var ${name}.`);
    }
    return value;
  };
  return {
    // Required, not defaulted. A default would point a production deploy that
    // forgot this one var at the STAGING host — production credentials, wrong
    // environment, no error — which is exactly the half-configured start this
    // function exists to prevent.
    baseUrl: required('GLOBEPAY_API_BASE').replace(
      /\/+$/,
      '',
    ),
    merchantCode: required('GLOBEPAY_MERCHANT_CODE'),
    aesKey: required('GLOBEPAY_AES_KEY'),
    privateKey: required('GLOBEPAY_MERCHANT_PRIVATE_KEY'),
    publicKey: required('GLOBEPAY_PUBLIC_KEY'),
    currencyCode: env.GLOBEPAY_CURRENCY ?? 'MYR',
  };
}

/** Their uniform response envelope (§1.1.4). `data` is plaintext, not AES. */
type GlobePayResponse<T> = {
  isSuccess: boolean;
  successCode?: number;
  errorCode?: string | null;
  errorMessage?: string | null;
  errorList?: { errorCode?: string; errorDescription?: string }[] | null;
  data?: T | null;
};

/**
 * Carries their error codes through so callers can branch on them — notably
 * PMT10000 (duplicate merchant reference), which is a REPLAY, not a failure,
 * and PMT10013 (insufficient balance) on payouts.
 */
export class GlobePayError extends Error {
  readonly codes: string[];
  readonly httpStatus: number;
  /**
   * True only when the gateway PARSEABLY refused (a JSON body with
   * isSuccess: false) — meaning no transaction exists on their side. False
   * for timeouts, resets, WAF pages and other ambiguity, where the request
   * may have been accepted and only the response was lost. Money-out callers
   * MUST branch on this: refunding an ambiguous submit would double-pay if
   * the payout later executes.
   *
   * "isSuccess: false" is meant literally. A response that says isSuccess TRUE
   * but carries no `data` is an ACCEPTED request with an unreadable payload,
   * and a body missing `isSuccess` entirely is not their envelope at all —
   * both are ambiguous, however much they look like failures from here.
   */
  readonly definite: boolean;

  constructor(
    message: string,
    codes: string[],
    httpStatus: number,
    definite = false,
  ) {
    super(message);
    this.name = 'GlobePayError';
    this.codes = codes;
    this.httpStatus = httpStatus;
    this.definite = definite;
  }

  has(code: string): boolean {
    return this.codes.includes(code);
  }
}

/**
 * POST one envelope. Timeout is mandatory, not optional: a hung gateway call
 * inside a deposit request would pin a worker and leave the customer staring
 * at a spinner with money possibly in flight.
 */
async function post<T>(
  path: string,
  payload: Record<string, unknown>,
  config: GlobePayConfig,
  timeoutMs = 20_000,
): Promise<T> {
  const envelope = buildEnvelope(payload, config);
  // PascalCase per their samples. Verified 2026-07-21 that their binding is
  // case-insensitive (both casings return 200), so this is presentation only.
  const body = {
    MerchantCode: envelope.merchantCode,
    Data: envelope.data,
    Signature: envelope.signature,
    Version: envelope.version,
  };

  const response = await fetch(`${config.baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const text = await response.text();
  let parsed: GlobePayResponse<T>;
  try {
    parsed = JSON.parse(text) as GlobePayResponse<T>;
  } catch {
    // An HTML error page or a WAF block — surface a truncated body rather than
    // a bare "Unexpected token <", which tells nobody anything.
    throw new GlobePayError(
      `GlobePay365 ${path}: non-JSON response (HTTP ${response.status}): ${text.slice(0, 200)}`,
      [],
      response.status,
    );
  }

  if (!parsed.isSuccess || !parsed.data) {
    const codes = [
      ...(parsed.errorCode ? [parsed.errorCode] : []),
      ...(parsed.errorList ?? []).flatMap((e) => (e.errorCode ? [e.errorCode] : [])),
    ];
    const detail =
      (parsed.errorList ?? [])
        .map((e) => `${e.errorCode}: ${e.errorDescription}`)
        .join('; ') ||
      parsed.errorMessage ||
      'unknown error';
    // `definite` answers a NARROWER question than "did this call fail", and
    // conflating the two costs real money on the payout path. It may only be
    // true when the gateway EXPLICITLY refused — `isSuccess: false` — because
    // that is the one shape that proves no transaction exists on their side.
    //
    // The other half of this condition, `!parsed.data`, is the opposite case:
    // the gateway said isSuccess TRUE and we simply could not read the payload.
    // The request was accepted. Calling that definite told startGlobePayWithdrawal
    // to refund a debit whose payout may well execute — the customer keeps the
    // credit AND the money leaves — and, worse, closed the row 'failed', which
    // drops it out of the sweep's status='pending' scan permanently so nothing
    // ever revisits it. The deposit mirror image writes off a live payment.
    //
    // Same reasoning covers a body with no `isSuccess` at all (a JSON error
    // page from something in front of them): not a parseable GlobePay refusal,
    // so not definite. Hence `=== false` rather than a truthiness check.
    //
    // Ambiguity is survivable in a way a wrong definite is not: the sweep can
    // refund a payout that never happened, but nothing can un-pay one that did.
    throw new GlobePayError(
      `GlobePay365 ${path} failed: ${detail}`,
      codes,
      response.status,
      parsed.isSuccess === false,
    );
  }

  return parsed.data;
}

export type SubmitDepositInput = {
  /** OUR reference. Must be unique — a repeat returns PMT10000. */
  merchantTransactionId: string;
  /** Our customer id, for their support/reconciliation views. */
  merchantClientId: string;
  /** MYR, 2dp. */
  amount: number;
  /** Server-to-server result callback. Must be publicly reachable. */
  notifyUrl: string;
  /** Where the customer's browser lands after the cashier. */
  returnUrl: string;
  /** The customer's IP, not ours. */
  ipAddress: string;
  /** FPX | DN | BQR | OB for MYR. */
  paymentMethodCode: string;
  /** Mandatory for BMR only; unused for our MYR methods. */
  sourceClientBankCode?: string;
};

export type SubmitDepositResult = {
  transactionId: string;
  /** Cashier page. ALWAYS redirect here — it renders their error page too. */
  url: string;
  bankCode?: string | null;
  accountNumber?: string | null;
  accountHolderName?: string | null;
  referenceNo?: string | null;
  qrCode?: string | null;
  depositActualAmount: number;
  deepLink?: string | null;
};

/**
 * §1.1 SubmitDeposit. Returns a cashier URL; NO money has moved and the
 * customer has not paid yet. Credit only on the callback (or a requery that
 * reports status 6).
 */
export function submitDeposit(
  input: SubmitDepositInput,
  config: GlobePayConfig,
): Promise<SubmitDepositResult> {
  return post<SubmitDepositResult>(
    '/api/Deposit/SubmitDeposit',
    {
      MerchantCode: config.merchantCode,
      MerchantTransactionId: input.merchantTransactionId,
      MerchantClientId: input.merchantClientId,
      CurrencyCode: config.currencyCode,
      // 2dp string: their sample sends "100.00", and a JS number would
      // serialize 100 as `100`, losing the format they show.
      Amount: input.amount.toFixed(2),
      NotifyUrl: input.notifyUrl,
      ReturnUrl: input.returnUrl,
      IPAddress: input.ipAddress,
      PaymentMethodCode: input.paymentMethodCode,
      ...(input.sourceClientBankCode
        ? { SourceClientBankCode: input.sourceClientBankCode }
        : {}),
    },
    config,
  );
}

export type DepositDetail = {
  transactionId: string;
  merchantTransactionId: string;
  statusId: number;
  status: string;
  amount: number;
  netAmount: number;
  paymentMethodCode: string;
  bankReferenceNo?: string | null;
  uniqueReferenceNo?: string | null;
};

/**
 * §1.3 Deposit Requery — the reconciliation path. A dropped callback must
 * never mean a lost deposit: this is the authoritative read.
 */
export async function getDepositDetail(
  merchantTransactionId: string,
  config: GlobePayConfig,
): Promise<DepositDetail & { state: SettlementState }> {
  const detail = await post<DepositDetail>(
    '/api/Deposit/GetDepositDetail',
    {
      MerchantCode: config.merchantCode,
      MerchantTransactionId: merchantTransactionId,
      CurrencyCode: config.currencyCode,
    },
    config,
  );
  return { ...detail, state: depositState(detail.statusId) };
}

export type SubmitWithdrawalInput = {
  /** OUR reference. Must be unique — a repeat returns PMT10000. */
  merchantTransactionId: string;
  /** Our customer id, for their support/reconciliation views. */
  merchantClientId: string;
  /** MYR, 2dp. */
  amount: number;
  /** Destination bank, from GetSupportedBanks (never the doc appendix). */
  destinationBankCode: string;
  destinationAccountNumber: string;
  destinationAccountHolderName: string;
  /** Server-to-server result callback. Must be publicly reachable. */
  notifyUrl: string;
  /** Payout Verification URL (§1.7) — they POST here and only continue the
   * payout on a literal "success". Inactive on staging, mandatory anyway. */
  returnUrl: string;
  /** The customer's IP, not ours. */
  ipAddress: string;
};

export type SubmitWithdrawalResult = {
  /** Their withdrawal id (W…). */
  transactionId: string;
};

/**
 * §1.5 SubmitWithdrawal. IMPORTANT ordering contract for callers: the ledger
 * debit must already be committed before this is called — once this returns,
 * real money is queued to leave the merchant balance.
 */
export function submitWithdrawal(
  input: SubmitWithdrawalInput,
  config: GlobePayConfig,
): Promise<SubmitWithdrawalResult> {
  return post<SubmitWithdrawalResult>(
    '/api/Withdrawal/SubmitWithdrawal',
    {
      MerchantCode: config.merchantCode,
      MerchantTransactionId: input.merchantTransactionId,
      MerchantClientId: input.merchantClientId,
      CurrencyCode: config.currencyCode,
      Amount: input.amount.toFixed(2),
      DestinationClientBankCode: input.destinationBankCode,
      DestinationClientAccountNumber: input.destinationAccountNumber,
      DestinationClientAccountHolderName: input.destinationAccountHolderName,
      NotifyUrl: input.notifyUrl,
      ReturnUrl: input.returnUrl,
      IPAddress: input.ipAddress,
      // MYR payouts are always WD (doc §"Withdrawal Method Appendix").
      PaymentMethodCode: 'WD',
    },
    config,
  );
}

export type WithdrawalDetail = {
  transactionId: string;
  merchantTransactionId: string;
  statusId: number;
  status: string;
  amount: number;
  netAmount: number;
  paymentMethodCode: string;
  bankReferenceNo?: string | null;
  uniqueReferenceNo?: string | null;
};

/**
 * §1.8 Withdrawal Requery — the authoritative read for payout reconciliation.
 * A lost withdrawal callback must never strand a customer's money in limbo.
 */
export async function getWithdrawalDetail(
  merchantTransactionId: string,
  config: GlobePayConfig,
): Promise<WithdrawalDetail & { state: SettlementState }> {
  const detail = await post<WithdrawalDetail>(
    '/api/Withdrawal/GetWithdrawalDetail',
    {
      MerchantCode: config.merchantCode,
      MerchantTransactionId: merchantTransactionId,
      CurrencyCode: config.currencyCode,
    },
    config,
  );
  return { ...detail, state: withdrawalState(detail.statusId) };
}

export type SupportedBank = {
  bankCode: string;
  bankName: string;
};

/**
 * GetSupportedBanks — plain GET, no AES and no signature (verified live
 * 2026-07-21, unlike every other endpoint). The doc's Bank Appendix is
 * incomplete, so the payout bank picker must be driven from THIS.
 */
export async function getSupportedBanks(
  config: GlobePayConfig,
): Promise<SupportedBank[]> {
  const url =
    `${config.baseUrl}/api/Bank/GetSupportedBanks` +
    `?MerchantCode=${encodeURIComponent(config.merchantCode)}` +
    `&PaymentMethodCode=WD&CurrencyCode=${encodeURIComponent(config.currencyCode)}`;
  const response = await fetch(url, {
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  let parsed: GlobePayResponse<SupportedBank[]>;
  try {
    parsed = JSON.parse(text) as GlobePayResponse<SupportedBank[]>;
  } catch {
    throw new GlobePayError(
      `GlobePay365 GetSupportedBanks: non-JSON response (HTTP ${response.status}): ${text.slice(0, 200)}`,
      [],
      response.status,
    );
  }
  if (!parsed.isSuccess || !parsed.data) {
    throw new GlobePayError(
      `GlobePay365 GetSupportedBanks failed: ${parsed.errorMessage ?? 'unknown error'}`,
      parsed.errorCode ? [parsed.errorCode] : [],
      response.status,
    );
  }
  return parsed.data;
}

export type MerchantBalance = {
  merchantCode: string;
  currencyCode: string;
  currentBalance: number;
  availableBalance: number;
  t1Balance: number;
};

/**
 * §1.9 CheckBalance. Read-only and side-effect free, so it doubles as the
 * connectivity/credentials smoke test after any key or whitelist change.
 */
export function checkBalance(config: GlobePayConfig): Promise<MerchantBalance> {
  return post<MerchantBalance>(
    '/api/Merchant/CheckBalance',
    { MerchantCode: config.merchantCode, CurrencyCode: config.currencyCode },
    config,
  );
}

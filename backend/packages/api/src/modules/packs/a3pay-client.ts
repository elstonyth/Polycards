import { buildEnvelope, payinState, payoutState } from './a3pay';
import { GatewayError, type SettlementState } from './gateway-types';

// A3Pay HTTP client (handbook v3.3.5, SGD). Thin: build the envelope, POST
// JSON, unwrap their { isSuccess, errorList, data } response. The wire format
// lives in a3pay.ts; this file only knows endpoints, field names and errors.
//
// The same client serves every tenant of the platform we hold an account
// with (A3PAY_FAMILY): A3Pay for SGD and GlobePay365 for USDT publish the
// same handbook, endpoints and crypto, and differ only in host, keys and
// currency — exactly as The 7 Pay shares TGPay's client.
//
// Amounts in and out of this file are in the GATEWAY's currency (SGD, USDT).
// The conversion to and from our RM ledger happens in the orchestration,
// against the rate locked on each row (fx-quote.ts) — never here.

export type A3payKind = 'a3pay' | 'gp365';

/**
 * The platform tenants: operator label, env prefix (A3PAY_API_BASE,
 * GP365_API_BASE, ...) and the currency the merchant account settles in.
 * GlobePay365's API doc (api.globepay365.com/api/globepay365_api_doc.html,
 * read 2026-10-12) is A3Pay's handbook with the names changed.
 */
export const A3PAY_FAMILY: Record<
  A3payKind,
  { label: string; envPrefix: string; currency: string }
> = {
  a3pay: { label: 'A3Pay', envPrefix: 'A3PAY', currency: 'SGD' },
  gp365: { label: 'GlobePay365', envPrefix: 'GP365', currency: 'USDT' },
};

export type A3payConfig<K extends A3payKind = A3payKind> = {
  kind: K;
  /** e.g. https://mapi.a3paysg.com — no trailing slash. */
  baseUrl: string;
  /** Their MID / MerchantCode, e.g. SGD00001. */
  merchantCode: string;
  aesKey: string;
  /** OURS, PKCS#8 base64 — signs every request. */
  privateKey: string;
  /** THEIRS, X.509 base64 — verifies every callback. */
  publicKey: string;
  currencyCode: string;
};

const CREDENTIALS = [
  'API_BASE',
  'MERCHANT_CODE',
  'AES_KEY',
  'MERCHANT_PRIVATE_KEY',
  'PUBLIC_KEY',
] as const;

/**
 * Read a tenant's config from env, failing loudly on a missing value. A
 * half-configured gateway must not start: the failure mode is silently
 * signing with an empty key and getting an opaque rejection hours later.
 */
export function a3payFamilyConfigFromEnv<K extends A3payKind>(
  kind: K,
  env: NodeJS.ProcessEnv = process.env,
): A3payConfig<K> {
  const { label, envPrefix, currency } = A3PAY_FAMILY[kind];
  const required = (suffix: (typeof CREDENTIALS)[number]): string => {
    const name = `${envPrefix}_${suffix}`;
    const value = env[name];
    if (!value) throw new Error(`${label}: missing required env var ${name}.`);
    return value;
  };
  const baseUrl = required('API_BASE').replace(/\/+$/, '');
  // https only — every request carries the signed, encrypted body. Plain http
  // is admitted for a loopback host alone, which is what the local mock
  // (scripts/a3pay-mock.mjs) listens on.
  if (
    !/^https:\/\//i.test(baseUrl) &&
    !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(baseUrl)
  ) {
    throw new Error(`${label}: ${envPrefix}_API_BASE must be an https URL.`);
  }
  // A staging host in production would open top-ups on a test cashier whose
  // signed "paid" callbacks credit real RM.
  if (env.NODE_ENV === 'production' && /stg/i.test(new URL(baseUrl).hostname)) {
    throw new Error(
      `${label}: ${envPrefix}_API_BASE points at a staging host in production.`,
    );
  }
  // Rows store the registry currency and are requeried in it (inRowCurrency):
  // any other CurrCode here would refuse every callback and read live rows as
  // "Not found", which authorises refunds.
  const currencyCode = env[`${envPrefix}_CURRENCY`] ?? currency;
  if (currencyCode !== currency) {
    throw new Error(
      `${label}: ${envPrefix}_CURRENCY must be ${currency}, not ${currencyCode}.`,
    );
  }
  return {
    kind,
    // Required, not defaulted: a default could only ever be production.
    baseUrl,
    merchantCode: required('MERCHANT_CODE'),
    aesKey: required('AES_KEY'),
    privateKey: required('MERCHANT_PRIVATE_KEY'),
    publicKey: required('PUBLIC_KEY'),
    currencyCode,
  };
}

/** Every credential a3payFamilyConfigFromEnv requires — the `configured` check. */
export function a3payFamilyConfigured(
  kind: A3payKind,
  env: Partial<NodeJS.ProcessEnv>,
): boolean {
  const { envPrefix } = A3PAY_FAMILY[kind];
  return CREDENTIALS.every((suffix) => Boolean(env[`${envPrefix}_${suffix}`]));
}

/** A3Pay (SGD)'s own config — the original single-tenant entry point. */
export function a3payConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): A3payConfig<'a3pay'> {
  return a3payFamilyConfigFromEnv('a3pay', env);
}

export function a3payConfigured(env: Partial<NodeJS.ProcessEnv>): boolean {
  return a3payFamilyConfigured('a3pay', env);
}

/**
 * A3Pay's "transaction not found" refusal, as a synthetic code — the ONLY
 * refusal the sweeps may read as "never existed" (gateway-reconcile.ts
 * classifyRequeryError).
 *
 * Measured live against production 2026-10-12 (scratch probe, MID polycards):
 * GetPayinDetail / GetPayoutDetail for an unknown MTransactionId answer
 * HTTP 400 {"isSuccess":false,"errorCode":null,"errorMessage":"Not found"}.
 * The failure modes that must NOT read as not-found all look different:
 *   wrong AES key       -> HTTP 400, plain-text "Invalid Request" (non-JSON)
 *   wrong MerchantCode  -> HTTP 403 problem+json without isSuccess
 *   wrong RSA signature -> IGNORED on read calls (same answer as a correct
 *                          one), so a signing-key fault cannot produce a
 *                          false "Not found" either.
 * The retired GlobePay365 client documented PMT10016 for the same platform;
 * it is still honoured if A3Pay ever sends it.
 */
export const A3PAY_NOT_FOUND = 'A3PAY_NOT_FOUND';
const PLATFORM_NOT_FOUND_CODE = 'PMT10016';

/**
 * OUR A3Pay balance cannot cover a payout (SubmitPayout only). A3Pay's exact
 * wording is unrecorded (our balance was S$0 when this shipped and no payout
 * had been tried), so any SubmitPayout refusal that talks about balance /
 * insufficient funds is tagged — the withdrawal paths then share TGPay's
 * float-empty breaker, alert and customer copy. The pre-submit balance check
 * in gateway-withdrawal.ts (regionalFloatShort) catches the common case
 * without depending on this wording at all.
 */
export const A3PAY_PAYOUT_FLOAT_EMPTY = 'A3PAY_PAYOUT_FLOAT_EMPTY';
const DETAIL_PATHS = new Set([
  '/api/Payin/GetPayinDetail',
  '/api/Payout/GetPayoutDetail',
]);

export class A3payError extends GatewayError {
  constructor(
    message: string,
    codes: string[],
    httpStatus: number,
    definite = false,
  ) {
    super(message, codes, httpStatus, definite);
    this.name = 'A3payError';
  }
}

/** Their uniform response envelope. `data` is plaintext, not AES. */
type A3payResponse<T> = {
  isSuccess?: boolean;
  successCode?: number;
  errorCode?: string | null;
  errorMessage?: string | null;
  errorList?:
    | {
        errorCode?: string;
        ErrorCode?: string;
        errorDescription?: string;
        ErrorDescription?: string;
      }[]
    | null;
  data?: T | null;
};

function failure<T>(
  path: string,
  parsed: A3payResponse<T>,
  httpStatus: number,
  label: string,
): A3payError {
  const list = parsed.errorList ?? [];
  const codes = [
    ...(parsed.errorCode ? [parsed.errorCode] : []),
    ...list.flatMap((e) => {
      const code = e.errorCode ?? e.ErrorCode;
      return code ? [code] : [];
    }),
  ];
  const detail =
    list
      .map(
        (e) =>
          `${e.errorCode ?? e.ErrorCode}: ${e.errorDescription ?? e.ErrorDescription}`,
      )
      .join('; ') ||
    parsed.errorMessage ||
    'unknown error';
  // Not-found, on the two requery endpoints only, from an EXPLICIT parsed
  // refusal: the exact message A3Pay sends, or the platform code.
  if (
    DETAIL_PATHS.has(path) &&
    parsed.isSuccess === false &&
    (/^not found$/i.test(String(parsed.errorMessage ?? '').trim()) ||
      codes.includes(PLATFORM_NOT_FOUND_CODE))
  ) {
    codes.push(A3PAY_NOT_FOUND);
  }
  if (
    path === '/api/Payout/SubmitPayout' &&
    parsed.isSuccess === false &&
    // Text only (A3Pay documents no code for it), so it is a HINT: the
    // caller confirms it against a balance read before acting on it.
    /insufficient|not enough|余额不足/i.test(detail)
  ) {
    codes.push(A3PAY_PAYOUT_FLOAT_EMPTY);
  }
  // `definite` only on an EXPLICIT isSuccess:false — the one shape that
  // proves no transaction exists on their side. isSuccess true with no data
  // is an ACCEPTED request we could not read, and a body without isSuccess
  // is not their envelope at all: both ambiguous. Refunding an ambiguous
  // payout could pay twice; the sweep can always refund later, nothing can
  // un-pay. (Same rule the retired gateway's client learned in #425.) A 5xx
  // is ambiguous even in their envelope: their side may have recorded the
  // payout before failing, and A3Pay posts payouts by hand (TGPay's rule too).
  return new A3payError(
    `${label} ${path} failed: ${detail}`,
    codes,
    httpStatus,
    parsed.isSuccess === false && httpStatus < 500,
  );
}

function parse<T>(
  path: string,
  text: string,
  httpStatus: number,
  label: string,
): A3payResponse<T> {
  try {
    return JSON.parse(text) as A3payResponse<T>;
  } catch {
    // An HTML error page or a WAF block (an un-whitelisted IP lands here).
    throw new A3payError(
      `${label} ${path}: non-JSON response (HTTP ${httpStatus}): ${text.slice(0, 200)}`,
      [],
      httpStatus,
    );
  }
}

/**
 * POST one envelope. The timeout is mandatory: a hung gateway call inside a
 * deposit request would pin a worker with money possibly in flight.
 */
async function post<T>(
  path: string,
  payload: Record<string, unknown>,
  config: A3payConfig,
  timeoutMs = 20_000,
): Promise<T> {
  const response = await fetch(`${config.baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildEnvelope(payload, config)),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const label = A3PAY_FAMILY[config.kind].label;
  const parsed = parse<T>(path, await response.text(), response.status, label);
  if (parsed.isSuccess !== true || !parsed.data) {
    throw failure(path, parsed, response.status, label);
  }
  return parsed.data;
}

/** 2dp string, as their samples send it ("100.00"); a JS number drops it. */
const money = (amount: number): string => amount.toFixed(2);

// ---------------------------------------------------------------------------
// Payin

export type CreatePayinInput = {
  merchantTransactionId: string;
  customerId: string;
  /** In config.currencyCode (SGD), 2dp. */
  amount: number;
  ipAddress: string;
  callbackUrl: string;
  returnUrl: string;
  /** OB (online banking) | BQR (QR) for SGD; UTRC | UERC for USDT. */
  paymentMethodId: string;
  /** The paying account's holder. Required for SGD; omitted for USDT. */
  accountHolderName?: string;
};

export type CreatePayinResult = {
  paymentOrderId: string;
  paymentURL: string;
  paymentBankCode?: string | null;
  paymentAccountNumber?: string | null;
  paymentAccountHolderName?: string | null;
  paymentReferenceNo?: string | null;
  paymentQRCode?: string | null;
  /** What the customer must actually transfer — SGD amounts are nudged up a
   *  cent to stay unique per receiving account (100 -> 100.01). */
  payinActualAmount: number;
  paymentDeepLink?: string | null;
  bankBranchCode?: string | null;
};

/** CreatePayin. Returns a cashier; NO money has moved yet. */
export function createPayin(
  input: CreatePayinInput,
  config: A3payConfig,
): Promise<CreatePayinResult> {
  return post<CreatePayinResult>(
    '/api/Payin/CreatePayin',
    {
      MID: config.merchantCode,
      MTransactionId: input.merchantTransactionId,
      MCustId: input.customerId,
      PayinAmount: money(input.amount),
      CurrCode: config.currencyCode,
      RequestIPAddress: input.ipAddress,
      CallbackURL: input.callbackUrl,
      ReturnClientURL: input.returnUrl,
      PaymentMethodId: input.paymentMethodId,
      ...(input.accountHolderName
        ? { FromCustomerAccountHolderName: input.accountHolderName }
        : {}),
    },
    config,
  );
}

export type PayinDetail = {
  paymentOrderId: string;
  mTransactionId: string;
  statusId: number;
  status: string;
  payinAmount: number;
  payinNetAmount: number;
  paymentMethodId: string;
};

/** GetPayinDetail — the authoritative read the sweep settles from. */
export async function getPayinDetail(
  merchantTransactionId: string,
  config: A3payConfig,
): Promise<PayinDetail & { state: SettlementState }> {
  const detail = await post<PayinDetail>(
    '/api/Payin/GetPayinDetail',
    {
      MID: config.merchantCode,
      MTransactionId: merchantTransactionId,
      CurrCode: config.currencyCode,
    },
    config,
  );
  return { ...detail, state: payinState(detail.statusId) };
}

// ---------------------------------------------------------------------------
// Payout

export type SubmitPayoutInput = {
  merchantTransactionId: string;
  customerId: string;
  /** In config.currencyCode (SGD), 2dp. */
  amount: number;
  ipAddress: string;
  /** A3Pay's own bank code (GetSupportedBankList), not our canonical id.
   *  USDT: USDTTRC / USDTERC, the wallet's network. */
  bankCode: string;
  /** USDT: the wallet address. */
  accountNumber: string;
  /** USDT: must equal MCustId (customerId), per GlobePay365's doc. */
  accountHolderName: string;
  callbackUrl: string;
  /** Payout Verification URL: they POST here and pay only on "success". */
  verifyUrl: string;
};

/**
 * SubmitPayout. Ordering contract for callers: the ledger debit is already
 * committed — once this returns, money is queued to leave our A3Pay balance.
 */
export function submitPayout(
  input: SubmitPayoutInput,
  config: A3payConfig,
): Promise<{ paymentOrderId: string }> {
  return post<{ paymentOrderId: string }>(
    '/api/Payout/SubmitPayout',
    {
      MID: config.merchantCode,
      MTransactionId: input.merchantTransactionId,
      MCustId: input.customerId,
      PayoutAmount: money(input.amount),
      CurrCode: config.currencyCode,
      RequestIPAddress: input.ipAddress,
      ToClientBankCode: input.bankCode,
      ToClientAccountNumber: input.accountNumber,
      ToClientAccountHolderName: input.accountHolderName,
      // Their spelling differs from the payin's CallbackURL.
      CallBackURL: input.callbackUrl,
      ReturnClientURL: input.verifyUrl,
      PaymentMethodId: 'WD',
    },
    config,
  );
}

export type PayoutDetail = {
  paymentOrderId?: string | null;
  mTransactionId: string;
  statusId: number;
  status: string;
  payoutAmount: number;
  payoutNetAmount: number;
  paymentMethodId: string;
};

/** GetPayoutDetail — the authoritative read for payout reconciliation. */
export async function getPayoutDetail(
  merchantTransactionId: string,
  config: A3payConfig,
): Promise<PayoutDetail & { state: SettlementState }> {
  const detail = await post<PayoutDetail>(
    '/api/Payout/GetPayoutDetail',
    {
      MID: config.merchantCode,
      MTransactionId: merchantTransactionId,
      CurrCode: config.currencyCode,
    },
    config,
  );
  return { ...detail, state: payoutState(detail.statusId) };
}

// ---------------------------------------------------------------------------
// Merchant / bank

export type A3payBalance = {
  /** Live API sends `mid`; the handbook sample shows `mID`. */
  mid?: string;
  mID?: string;
  t1BalanceAmount?: number;
  currCode: string;
  currentBalanceAmount: number;
  availableBalanceAmount: number;
};

/** CheckAccBalance — read-only; doubles as the credentials smoke test. */
export function checkAccBalance(config: A3payConfig): Promise<A3payBalance> {
  return post<A3payBalance>(
    '/api/Merchant/CheckAccBalance',
    { MID: config.merchantCode, CurrCode: config.currencyCode },
    config,
  );
}

export type A3payBank = {
  bankName: string;
  bankNameOrigin?: string;
  bankCode: string;
  currCode: string;
};

/** GetSupportedBankList — plain GET, no envelope (unlike every other call). */
export async function getSupportedBankList(
  config: A3payConfig,
): Promise<A3payBank[]> {
  const path = '/api/Bank/GetSupportedBankList';
  const url =
    `${config.baseUrl}${path}?MID=${encodeURIComponent(config.merchantCode)}` +
    `&PaymentMethodId=WD&currCode=${encodeURIComponent(config.currencyCode)}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  const label = A3PAY_FAMILY[config.kind].label;
  const parsed = parse<A3payBank[]>(
    path,
    await response.text(),
    response.status,
    label,
  );
  if (parsed.isSuccess !== true || !parsed.data) {
    throw failure(path, parsed, response.status, label);
  }
  return parsed.data;
}

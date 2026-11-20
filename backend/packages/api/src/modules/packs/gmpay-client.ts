import { createHash, timingSafeEqual } from 'node:crypto';
import { GatewayError, type SettlementState } from './gateway-types';

// GMpay HTTP client (their PayFlowXZ platform, API v3:
// https://xapi.payflowxz.com/v3/doc, read 2026-11-19). The Singapore (SGD)
// rail that replaced A3Pay. Plain JSON over HTTPS, every request and callback
// signed with SHA-256 over the sorted non-empty fields plus our secret key.
//
// Amounts in and out of this file are in the GATEWAY's currency (SGD). The
// conversion to and from our RM ledger happens in the orchestration, against
// the rate locked on each row (payment-fx.ts) — never here.
//
// Staging and production share one host (GMpay, 2026-11-19: "for production
// you only need to switch the Client ID and Secret Key"), so no host check can
// tell a staging key from a production one. The keys are the only difference.

export type GmpayConfig = {
  kind: 'gmpay';
  /** e.g. https://xapi.payflowxz.com/v3 — no trailing slash. */
  baseUrl: string;
  clientId: string;
  /** Signs every request and verifies every callback. */
  secretKey: string;
  currencyCode: string;
};

const LABEL = 'GMpay';
const CREDENTIALS = [
  'GMPAY_API_BASE',
  'GMPAY_CLIENT_ID',
  'GMPAY_SECRET_KEY',
] as const;

/** Read the config from env, failing loudly on a missing value. */
export function gmpayConfigFromEnv(
  env: Partial<NodeJS.ProcessEnv> = process.env,
): GmpayConfig {
  const required = (name: (typeof CREDENTIALS)[number]): string => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`${LABEL}: missing required env var ${name}.`);
    return value;
  };
  const baseUrl = required('GMPAY_API_BASE').replace(/\/+$/, '');
  // https only: every request carries our signature. Plain http is admitted
  // for a loopback host alone, which is what the local mock listens on.
  if (
    !/^https:\/\//i.test(baseUrl) &&
    !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(baseUrl)
  ) {
    throw new Error(`${LABEL}: GMPAY_API_BASE must be an https URL.`);
  }
  return {
    kind: 'gmpay',
    baseUrl,
    clientId: required('GMPAY_CLIENT_ID'),
    secretKey: required('GMPAY_SECRET_KEY'),
    currencyCode: (env.GMPAY_CURRENCY?.trim() || 'SGD').toUpperCase(),
  };
}

export function gmpayConfigured(env: Partial<NodeJS.ProcessEnv>): boolean {
  return CREDENTIALS.every((name) => Boolean(env[name]?.trim()));
}

// ---------------------------------------------------------------------------
// Signature

type Fields = Record<string, unknown>;

const SIGNATURE_FIELDS = new Set(['tran_signature', 'signature']);

/**
 * Their signature: SHA-256 (hex) of the NON-EMPTY fields other than the
 * signature, sorted by key in ASCII order, joined as `key=value&...`, with
 * the secret key appended directly. Reproduces the doc's own example.
 */
export function gmpaySign(fields: Fields, secretKey: string): string {
  const base = Object.keys(fields)
    .filter((key) => !SIGNATURE_FIELDS.has(key))
    .filter((key) => {
      const value = fields[key];
      return value !== undefined && value !== null && String(value) !== '';
    })
    .sort()
    .map((key) => `${key}=${String(fields[key])}`)
    .join('&');
  return createHash('sha256')
    .update(base + secretKey)
    .digest('hex');
}

/**
 * A flat JSON object's fields as the TEXT they were written in. JSON.parse
 * would read `100.00` as 100, and they sign the text they sent, so the
 * signature over a re-serialised body would not match. Nested values are
 * refused: nothing they document nests, and guessing how they sign one would
 * be guessing at the money gate.
 */
function flatFieldText(raw: string): Record<string, string | null> {
  // Validates the whole document first; the scan below then only has to walk
  // well-formed JSON.
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('not a JSON object');
  }
  const out: Record<string, string | null> = {};
  let i = raw.indexOf('{') + 1;
  const ws = () => {
    while (i < raw.length && /\s/.test(raw[i])) i += 1;
  };
  const stringLiteral = (): string => {
    const start = i;
    i += 1;
    while (raw[i] !== '"') i += raw[i] === '\\' ? 2 : 1;
    i += 1;
    return JSON.parse(raw.slice(start, i)) as string;
  };
  ws();
  if (raw[i] === '}') return out;
  for (;;) {
    ws();
    const key = stringLiteral();
    ws();
    i += 1; // ':'
    ws();
    if (raw[i] === '"') {
      out[key] = stringLiteral();
    } else if (raw[i] === '{' || raw[i] === '[') {
      throw new Error(`nested value at "${key}"`);
    } else {
      const start = i;
      while (i < raw.length && raw[i] !== ',' && raw[i] !== '}') i += 1;
      const text = raw.slice(start, i).trim();
      out[key] = text === 'null' ? null : text;
    }
    ws();
    if (raw[i] === '}') return out;
    i += 1; // ','
  }
}

/**
 * A callback's fields, once its signature checks out against OUR secret key.
 * Throws on anything else, so nothing in an unsigned or foreign body is ever
 * read for money. Values are the text as sent (numbers too).
 */
export function readSignedCallback(
  rawBody: string,
  config: Pick<GmpayConfig, 'secretKey'>,
): Record<string, string | null> {
  const fields = flatFieldText(rawBody);
  const given = String(fields.tran_signature ?? fields.signature ?? '')
    .trim()
    .toLowerCase();
  const expected = gmpaySign(fields, config.secretKey);
  const ok =
    /^[0-9a-f]{64}$/.test(given) &&
    timingSafeEqual(Buffer.from(given), Buffer.from(expected));
  if (!ok) throw new Error('signature verification failed');
  return fields;
}

// ---------------------------------------------------------------------------
// Statuses

/** Pay-in: initiated | expired | completed. Anything else waits. */
export function gmpayPayinState(status: unknown): SettlementState {
  const s = String(status ?? '')
    .trim()
    .toLowerCase();
  if (s === 'completed') return 'success';
  if (s === 'expired') return 'failed';
  return 'pending';
}

/** Payout: initiated | rejected | completed. Anything else waits. */
export function gmpayPayoutState(status: unknown): SettlementState {
  const s = String(status ?? '')
    .trim()
    .toLowerCase();
  if (s === 'completed') return 'success';
  if (s === 'rejected') return 'failed';
  return 'pending';
}

// ---------------------------------------------------------------------------
// Errors

/**
 * A status check with no token of theirs to ask about. Their payinQuery and
 * payoutQuery take ONLY their token, so a row whose create call never
 * returned one cannot be looked up at all. That is unclear, never
 * "not found": a payout whose submit timed out may still exist.
 */
export const GMPAY_NO_TOKEN = 'GMPAY_NO_TOKEN';

/**
 * A payout refusal that talks about our balance. A HINT only: the adapter
 * names it 'wallet-empty' once its own balance read confirms it.
 */
export const GMPAY_PAYOUT_FLOAT_EMPTY = 'GMPAY_PAYOUT_FLOAT_EMPTY';

/**
 * Payout refusals known to create no payout, so the debit may be returned at
 * once. Everything else stays unclear until proven: refunding a payout that
 * was in fact created would pay twice. Extend only from what staging shows.
 */
const PAYOUT_CREATES_NOTHING = new Set(['INVALID_IP']);

export class GmpayError extends GatewayError {
  constructor(
    message: string,
    codes: string[],
    httpStatus: number,
    definite = false,
    named: ConstructorParameters<typeof GatewayError>[4] = {},
  ) {
    super(message, codes, httpStatus, definite, named);
    this.name = 'GmpayError';
  }
}

type GmpayResponse = Record<string, unknown> & {
  status_code?: number | string;
  status_msg?: string;
};

type Path =
  'payin' | 'payout' | 'payinQuery' | 'payoutQuery' | 'balance' | 'banklist';

function failure(
  path: Path,
  parsed: GmpayResponse,
  httpStatus: number,
): GmpayError {
  const message = String(parsed.status_msg ?? 'unknown error').trim();
  const codes = [`GMPAY_${message.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`];
  const parsedRefusal = httpStatus < 500;
  // Only a parsed refusal may hint at an empty wallet: a 5xx says nothing
  // about whether the payout was created, so it never feeds the refund
  // without a lookup (refundsWithoutLookup's 'wallet-empty').
  if (
    parsedRefusal &&
    path === 'payout' &&
    /insufficient|not enough|balance|余额/i.test(message)
  ) {
    codes.push(GMPAY_PAYOUT_FLOAT_EMPTY);
  }
  // A refused pay-in leaves nothing the customer could pay: they only ever
  // reach a cashier through the link a SUCCESSFUL create returns. A refused
  // payout is definite only when the refusal is known to create nothing.
  // Lookups never act on `definite`.
  const createsNothing =
    parsedRefusal &&
    path === 'payout' &&
    PAYOUT_CREATES_NOTHING.has(message.toUpperCase());
  const definite = (parsedRefusal && path === 'payin') || createsNothing;
  // They answer refusals with HTTP 200 and status_code -1. Recorded as 400 so
  // the sweeps read a refused lookup as ambiguous (wait) rather than as a
  // transport failure that aborts the whole run.
  return new GmpayError(
    `${LABEL} ${path} failed: ${message}`,
    codes,
    parsedRefusal ? 400 : httpStatus,
    definite,
    // Named so the payout path refunds without the lookup GMpay cannot
    // answer (withdrawal-submit.ts refundsWithoutLookup).
    createsNothing ? { result: 'creates-nothing' } : {},
  );
}

/**
 * POST one signed request. The timeout is mandatory: a hung gateway call
 * inside a deposit request would pin a worker with money possibly in flight.
 */
async function post(
  path: Path,
  body: Fields,
  config: GmpayConfig,
  timeoutMs = 20_000,
): Promise<GmpayResponse> {
  const fields: Fields = { client_id: config.clientId, ...body };
  fields.tran_signature = gmpaySign(fields, config.secretKey);
  const response = await fetch(`${config.baseUrl}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(fields),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let parsed: GmpayResponse;
  try {
    parsed = JSON.parse(text) as GmpayResponse;
  } catch {
    // An HTML error page or a proxy block: their side may still have acted.
    throw new GmpayError(
      `${LABEL} ${path}: non-JSON response (HTTP ${response.status}): ${text.slice(0, 200)}`,
      [],
      response.status,
    );
  }
  // Their refusals always carry status_code -1. A body without one is read
  // for what it holds (a create without a token is still unclear, tokenOf),
  // never as a definite refusal that would close a row they may have opened.
  const refused =
    parsed.status_code !== undefined &&
    parsed.status_code !== null &&
    Number(parsed.status_code) !== 0;
  if (response.status >= 500 || refused) {
    throw failure(path, parsed, response.status);
  }
  return parsed;
}

/** Money as they take it: a JSON number, at most 2dp. */
const money = (amount: number): number => Math.round(amount * 100) / 100;

const num = (value: unknown): number => Number(value);

const str = (value: unknown): string | null =>
  value === undefined || value === null || value === '' ? null : String(value);

/** An accepted create that came back without their token cannot be followed. */
function tokenOf(path: Path, parsed: GmpayResponse): string {
  const token = str(parsed.tran_token);
  if (!token) {
    throw new GmpayError(
      `${LABEL} ${path}: accepted but no tran_token in the answer`,
      ['GMPAY_NO_TOKEN_RETURNED'],
      200,
    );
  }
  return token;
}

// ---------------------------------------------------------------------------
// Contracts

/**
 * Their contract codes ("Cont_code", back office → Account → Contract
 * Management), per currency, from the storefront rail codes. BQR is the
 * sheet's PayNow QR, OB its online banking.
 */
export const GMPAY_PAYIN_CONTRACTS: Record<string, Record<string, string>> = {
  SGD: { BQR: 'SGD_PAYNOW', OB: 'SGD_ONLINEBANKING' },
};

/** The payout contract (GMpay's onboarding email lists one per currency). */
export const GMPAY_PAYOUT_CONTRACTS: Record<string, string> = {
  SGD: 'SGD_BANKTRANSFER',
};

// ---------------------------------------------------------------------------
// Pay-in

export type CreatePayinInput = {
  merchantTransactionId: string;
  /** Our opaque customer id: their "customer username". */
  customerId: string;
  /** In config.currencyCode. */
  amount: number;
  contractCode: string;
  /** The paying customer's bank, as they require for every pay-in. */
  payerBankCode: string;
  payerHolderName: string;
  payerAccountNumber: string;
  callbackUrl: string;
  returnUrl: string;
};

export type CreatePayinResult = {
  tranToken: string;
  redirectTo: string;
  amount: number;
  fee: number;
  qrCode: string | null;
  bankName: string | null;
  bankAccountNumber: string | null;
  bankAccountName: string | null;
  bankReference: string | null;
};

/** POST /payin. Returns a cashier; NO money has moved yet. */
export async function createPayin(
  input: CreatePayinInput,
  config: GmpayConfig,
): Promise<CreatePayinResult> {
  const r = await post(
    'payin',
    {
      currency: config.currencyCode,
      cont_code: input.contractCode,
      tran_customer: input.customerId,
      tran_customer_bank_code: input.payerBankCode,
      tran_customer_bank_holder_name: input.payerHolderName,
      tran_customer_bank_account: input.payerAccountNumber,
      tran_amount: money(input.amount),
      tran_unique: input.merchantTransactionId,
      tran_return_url_success: input.returnUrl,
      tran_return_url_fail: input.returnUrl,
      tran_callback_url: input.callbackUrl,
    },
    config,
  );
  return {
    tranToken: tokenOf('payin', r),
    redirectTo: String(r.redirect_to ?? ''),
    amount: num(r.tran_amount),
    fee: num(r.tran_fee),
    qrCode: str(r.qrcode),
    bankName: str(r.bank_name),
    bankAccountNumber: str(r.bank_account_number),
    bankAccountName: str(r.bank_account_name),
    bankReference: str(r.bank_reference),
  };
}

export type TransactionStatus = {
  tranToken: string;
  merchantTransactionId: string;
  status: string;
  amount: number;
  fee: number;
};

function noToken(path: Path): GmpayError {
  return new GmpayError(
    `${LABEL} ${path}: no tran_token on the row to ask about`,
    [GMPAY_NO_TOKEN],
    400,
  );
}

function statusOf(r: GmpayResponse, token: string): TransactionStatus {
  return {
    tranToken: str(r.tran_token) ?? token,
    merchantTransactionId: String(r.tran_unique ?? ''),
    status: String(r.tran_status ?? ''),
    // What actually moved when they report it, else what was asked: a sweep
    // credits a status check verbatim, so it must never read the asked sum
    // over a different one that arrived.
    amount: moved(r),
    fee: num(r.tran_fee),
  };
}

/** What moved: the actual amount when reported, else the asked; NaN if
 *  neither. Shared by status checks and callbacks so they never drift. */
export function moved(r: Record<string, unknown>): number {
  for (const value of [r.tran_actual_amount, r.tran_amount]) {
    const n = num(value);
    if (
      value !== undefined &&
      value !== null &&
      value !== '' &&
      Number.isFinite(n) &&
      n > 0
    ) {
      return n;
    }
  }
  return NaN;
}

/** POST /payinQuery — by THEIR token only. */
export async function payinQuery(
  tranToken: string | null | undefined,
  config: GmpayConfig,
): Promise<TransactionStatus> {
  if (!tranToken) throw noToken('payinQuery');
  return statusOf(
    await post('payinQuery', { tran_token: tranToken }, config),
    tranToken,
  );
}

// ---------------------------------------------------------------------------
// Payout

export type SubmitPayoutInput = {
  merchantTransactionId: string;
  customerId: string;
  /** In config.currencyCode. */
  amount: number;
  /** THEIR bank code (banks.ts gatewayBankCode). */
  bankCode: string;
  accountName: string;
  accountNumber: string;
  callbackUrl: string;
};

/** POST /payout. Returns their token; the payout itself settles later. */
export async function submitPayout(
  input: SubmitPayoutInput,
  config: GmpayConfig,
): Promise<{ tranToken: string; fee: number }> {
  const contract = GMPAY_PAYOUT_CONTRACTS[config.currencyCode];
  const r = await post(
    'payout',
    {
      currency: config.currencyCode,
      ...(contract ? { cont_code: contract } : {}),
      tran_customer: input.customerId,
      bank_code: input.bankCode,
      bank_account_name: input.accountName,
      bank_account_number: input.accountNumber,
      tran_amount: money(input.amount),
      tran_unique: input.merchantTransactionId,
      tran_callback_url: input.callbackUrl,
    },
    config,
  );
  return { tranToken: tokenOf('payout', r), fee: num(r.tran_fee) };
}

/** POST /payoutQuery — by THEIR token only. */
export async function payoutQuery(
  tranToken: string | null | undefined,
  config: GmpayConfig,
): Promise<TransactionStatus> {
  if (!tranToken) throw noToken('payoutQuery');
  return statusOf(
    await post('payoutQuery', { tran_token: tranToken }, config),
    tranToken,
  );
}

// ---------------------------------------------------------------------------
// Merchant

export async function balance(
  config: GmpayConfig,
): Promise<{ balance: number; available: number }> {
  const r = await post('balance', { currency: config.currencyCode }, config);
  return { balance: num(r.balance), available: num(r.available_balance) };
}

export async function bankList(
  config: GmpayConfig,
): Promise<{ code: string; name: string }[]> {
  const r = await post('banklist', { currency: config.currencyCode }, config);
  let list: unknown = r.bank_list;
  if (typeof list === 'string') list = JSON.parse(list);
  return Array.isArray(list)
    ? list.map((b: { code?: unknown; name?: unknown }) => ({
        code: String(b.code ?? ''),
        name: String(b.name ?? ''),
      }))
    : [];
}

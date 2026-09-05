import { timingSafeEqual } from 'node:crypto';
import { GlobePayError } from './globepay-client';

// TGPay HTTP client (sandbox docs read 2026-09-05, sandbox.tgpay365.com/docs/api).
// Plain JSON over HTTPS: two static key headers and a unix `epoch` that must
// be within ±5 minutes of their clock. No AES, no RSA — the whole wire format
// GlobePay365 needed lives in globepay.ts and is not used here.
//
// Every function takes config explicitly so it stays unit-testable without a
// container; the env reader is the only thing that touches process.env.

export type TgpayConfig = {
  kind: 'tgpay';
  /** e.g. https://sandbox-api.tgpay365.com/api/v2 — no trailing slash. */
  baseUrl: string;
  publicKey: string;
  secretKey: string;
  currencyCode: string;
};

export function tgpayConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): TgpayConfig {
  const required = (name: string): string => {
    const value = env[name];
    if (!value) throw new Error(`TGPay: missing required env var ${name}.`);
    return value;
  };
  return {
    kind: 'tgpay',
    // Required, not defaulted, for the same reason as GLOBEPAY_API_BASE: a
    // default would let a production deploy silently talk to the sandbox.
    baseUrl: required('TGPAY_API_BASE').replace(/\/+$/, ''),
    publicKey: required('TGPAY_PUBLIC_KEY'),
    secretKey: required('TGPAY_SECRET_KEY'),
    currencyCode: env.TGPAY_CURRENCY ?? 'MYR',
  };
}

/** The sandbox accepts only its dummy bank for payouts; production only SWIFT. */
export function tgpayIsSandbox(config: Pick<TgpayConfig, 'baseUrl'>): boolean {
  return /sandbox/i.test(config.baseUrl);
}

/**
 * Same error class as GlobePay so the orchestration's `definite` / `httpStatus`
 * / `has()` branches keep their meaning. `codes` carries a synthetic code per
 * HTTP class so callers can branch without parsing message text.
 */
export class TgpayError extends GlobePayError {
  constructor(
    message: string,
    codes: string[],
    httpStatus: number,
    definite = false,
  ) {
    super(message, codes, httpStatus, definite);
    this.name = 'TgpayError';
  }
}

export const TGPAY_NOT_FOUND = 'TGPAY_NOT_FOUND';

type TgpayResponse<T> = { status?: number; msg?: string; data?: T };
type TgpayErrorBody = {
  statusCode?: number;
  message?: string;
  error?: string;
  errors?: string;
};

export function epochNow(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * POST one JSON body with the key headers. A parseable 4xx is `definite`
 * (their API answered and refused, nothing was created); anything else —
 * timeout, reset, WAF page, 5xx — is ambiguous and must not be refunded on.
 */
async function post<T>(
  path: string,
  body: Record<string, unknown>,
  config: TgpayConfig,
  timeoutMs = 20_000,
): Promise<T> {
  const response = await fetch(`${config.baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-public-key': config.publicKey,
      'x-secret-key': config.secretKey,
    },
    body: JSON.stringify({ epoch: epochNow(), ...body }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const text = await response.text();
  let parsed: TgpayResponse<T> & TgpayErrorBody;
  try {
    parsed = JSON.parse(text) as TgpayResponse<T> & TgpayErrorBody;
  } catch {
    throw new TgpayError(
      `TGPay ${path}: non-JSON response (HTTP ${response.status}): ${text.slice(0, 200)}`,
      [],
      response.status,
    );
  }

  if (response.status >= 400 || parsed.status !== 1 || !parsed.data) {
    const detail =
      parsed.errors ??
      parsed.message ??
      parsed.msg ??
      `HTTP ${response.status}`;
    const codes: string[] = [];
    if (response.status === 404) codes.push(TGPAY_NOT_FOUND);
    if (response.status === 401) codes.push('TGPAY_UNAUTHORIZED');
    throw new TgpayError(
      `TGPay ${path} failed (HTTP ${response.status}): ${detail}`,
      codes,
      response.status,
      // 4xx with a JSON body = they parsed us and said no. 5xx and 2xx-without-
      // data are ambiguous: the request may have been accepted.
      response.status >= 400 && response.status < 500,
    );
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Pay-in

export type TgpayCustomer = {
  name: string;
  email: string;
  phoneNumber: string;
};

export type CreatePaymentInput = {
  merchantRefNum: string;
  amount: number;
  notifyUrl: string;
  redirectUrl: string;
  customer: TgpayCustomer;
  /** FPX | EWALLET; omit to let the payer choose on the hosted page. */
  paymentMethod?: 'FPX' | 'EWALLET';
  additionalData?: string;
};

export type CreatePaymentResult = {
  checkoutLink: string;
  /** The `order` query param of checkoutLink — their transaction id. */
  order: string | null;
};

/** `order` is the only id create-payment returns; it rides in the link. */
export function orderFromCheckoutLink(link: string): string | null {
  const q = link.indexOf('?');
  if (q === -1) {
    // Custom-channel links are path-shaped: /create-payment/{pm}/{channel}/{order}
    const last = link.split('/').filter(Boolean).pop();
    // Their ids are 32-hex; anything short is a route word, not an order.
    return last && /^[A-Za-z0-9_-]{16,}$/.test(last) ? last : null;
  }
  return new URLSearchParams(link.slice(q + 1)).get('order');
}

export async function createPayment(
  input: CreatePaymentInput,
  config: TgpayConfig,
): Promise<CreatePaymentResult> {
  const data = await post<{ checkoutLink: string }>(
    '/transaction/create-payment',
    {
      customer: input.customer,
      order: {
        merchantRefNum: input.merchantRefNum,
        amount: Number(input.amount.toFixed(2)),
        notifyUrl: input.notifyUrl,
        redirectUrl: input.redirectUrl,
        ...(input.paymentMethod ? { paymentMethod: input.paymentMethod } : {}),
        ...(input.additionalData
          ? { additionalData: input.additionalData }
          : {}),
      },
    },
    config,
  );
  if (!data.checkoutLink) {
    throw new TgpayError(
      'TGPay create-payment: response carried no checkoutLink',
      [],
      200,
    );
  }
  return {
    checkoutLink: data.checkoutLink,
    order: orderFromCheckoutLink(data.checkoutLink),
  };
}

export type PaymentQuery = {
  order: string;
  amount: number;
  fee: number;
  amountAfterFee: number;
  status: string;
  datetime: string;
  paymentMethod: string;
  bankName: string;
};

export function queryPayment(
  merchantRefNum: string,
  config: TgpayConfig,
): Promise<PaymentQuery> {
  return post<PaymentQuery>('/transaction/query', { merchantRefNum }, config);
}

// ---------------------------------------------------------------------------
// Payout

export type CreatePayoutInput = {
  merchantRefNum: string;
  amount: number;
  email: string;
  userName: string;
  bankAccNumber: string;
  bankCode: string;
  bankName: string;
  notifyUrl: string;
};

export type CreatePayoutResult = { transactionRefNum: string };

export function createPayout(
  input: CreatePayoutInput,
  config: TgpayConfig,
): Promise<CreatePayoutResult> {
  return post<CreatePayoutResult>(
    '/transaction/payout/withdraw',
    { ...input, amount: Number(input.amount.toFixed(2)) },
    config,
  );
}

export type PayoutQuery = {
  status: string;
  order: {
    payoutRefNum: string;
    merchantRefNum: string;
    amount: number;
    fee: number;
    amountIncludeFee: number;
  };
};

export function queryPayout(
  merchantRefNum: string,
  config: TgpayConfig,
): Promise<PayoutQuery> {
  return post<PayoutQuery>('/transaction/query', { merchantRefNum }, config);
}

// ---------------------------------------------------------------------------
// Balances

type Balance = { balance: number; currency: { code: string; name: string } };

export async function balances(config: TgpayConfig): Promise<{
  payin: number;
  payout: number;
  currencyCode: string;
  /** Wallets the API has no row for (a fresh tenant, or a currency mismatch). */
  missing: ('payin' | 'payout')[];
}> {
  const body = { currency: config.currencyCode };
  // A wallet row only exists once it has been funded — a fresh sandbox tenant
  // has no pay-in credit row until its first payment settles. That 404 is
  // "zero", not "unreachable"; any other error still throws.
  const read = async (path: string): Promise<Balance | null> => {
    try {
      return await post<Balance>(path, body, config);
    } catch (error) {
      if (error instanceof TgpayError && error.has(TGPAY_NOT_FOUND)) return null;
      throw error;
    }
  };
  const [payin, payout] = await Promise.all([
    read('/tenant-credits/balance'),
    read('/tenant-payout-credits/balance'),
  ]);
  const missing: ('payin' | 'payout')[] = [];
  if (!payin) missing.push('payin');
  if (!payout) missing.push('payout');
  return {
    payin: Number(payin?.balance ?? 0),
    payout: Number(payout?.balance ?? 0),
    currencyCode:
      payin?.currency?.code ?? payout?.currency?.code ?? config.currencyCode,
    missing,
  };
}

// ---------------------------------------------------------------------------
// Status mapping

/**
 * Pay-in `status` strings seen in the docs: APPROVED, PENDING, and "other
 * values your integration defines". Only APPROVED credits; only an explicit
 * reject/fail closes the row. Anything unknown stays pending — the same
 * never-write-off-on-doubt rule as GlobePay's depositState.
 */
export function tgpayPaymentState(
  status: string,
): 'success' | 'failed' | 'pending' {
  const s = status.trim().toUpperCase();
  if (s === 'APPROVED' || s === 'SUCCESS') return 'success';
  if (s === 'REJECT' || s === 'REJECTED' || s === 'FAILED' || s === 'FAIL')
    return 'failed';
  return 'pending';
}

/** Payout callback states are documented lowercase: pending | success | reject. */
export const tgpayPayoutState = tgpayPaymentState;

// ---------------------------------------------------------------------------
// Inbound callbacks. TGPay authenticates its server-notify POSTs with the SAME
// two headers we send outbound. Constant-time compare, and both must match —
// the public key alone is visible to anyone who has seen a request from us.

function sameSecret(given: unknown, expected: string): boolean {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function tgpayCallbackAuthorized(
  headers: Record<string, unknown>,
  config: Pick<TgpayConfig, 'publicKey' | 'secretKey'>,
): boolean {
  return (
    sameSecret(headers['x-public-key'], config.publicKey) &&
    sameSecret(headers['x-secret-key'], config.secretKey)
  );
}

// ---------------------------------------------------------------------------
// Callback source allowlist. TGPay asked for one on top of the key headers
// ("请做 IP 白名单校验"). Enforced by the hooks whenever TGPAY_CALLBACK_IPS is
// set; entries are IPv4 addresses or CIDR blocks, comma/space separated.
// Unset = header-only (the sandbox calls from addresses they did not list).

export type CallbackAllowEntry = { base: number; bits: number };

function ipv4ToInt(ip: string): number | null {
  const parts = ip.trim().split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

/** Parse "1.2.3.4, 5.6.7.0/24" → entries; garbage entries are dropped. */
export function parseCallbackAllowlist(
  raw: string | undefined,
): CallbackAllowEntry[] {
  if (!raw) return [];
  const entries: CallbackAllowEntry[] = [];
  for (const token of raw.split(/[\s,]+/).filter(Boolean)) {
    const [ip, maskRaw] = token.split('/');
    const base = ipv4ToInt(ip);
    const bits = maskRaw === undefined ? 32 : Number(maskRaw);
    if (base === null || !Number.isInteger(bits) || bits < 0 || bits > 32) {
      continue;
    }
    entries.push({ base, bits });
  }
  return entries;
}

export function callbackIpAllowed(
  ip: string,
  entries: readonly CallbackAllowEntry[],
): boolean {
  const n = ipv4ToInt(ip);
  if (n === null) return false;
  return entries.some(({ base, bits }) => {
    if (bits === 0) return true;
    const mask = bits === 32 ? 0xffffffff : (0xffffffff << (32 - bits)) >>> 0;
    return ((n & mask) >>> 0) === ((base & mask) >>> 0);
  });
}

/**
 * The hooks' verdict: null when no allowlist is configured (header-only),
 * true/false otherwise. Read per call so an env change needs no redeploy.
 */
export function tgpayCallbackIpVerdict(
  ip: string,
  env: { TGPAY_CALLBACK_IPS?: string } = process.env,
): boolean | null {
  const entries = parseCallbackAllowlist(env.TGPAY_CALLBACK_IPS);
  if (entries.length === 0) return null;
  return callbackIpAllowed(ip, entries);
}

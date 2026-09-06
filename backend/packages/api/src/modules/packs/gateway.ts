import * as tgpay from './tgpay-client';
import type { TgpayConfig } from './tgpay-client';
import { PACKS_MODULE } from './index';
import {
  banksFor,
  findBank,
  gatewayBankCode,
  TGPAY_SANDBOX_BANK,
} from './banks';
import { netOfFee } from './money';
import type {
  DepositDetail,
  MerchantBalance,
  SubmitDepositInput,
  SubmitDepositResult,
  SubmitWithdrawalInput,
  SubmitWithdrawalResult,
  SupportedBank,
  WithdrawalDetail,
} from './gateway-types';

export { GatewayError } from './gateway-types';
export type {
  DepositDetail,
  MerchantBalance,
  SettlementState,
  SubmitDepositInput,
  SubmitDepositResult,
  SubmitWithdrawalInput,
  SubmitWithdrawalResult,
  SupportedBank,
  WithdrawalDetail,
} from './gateway-types';

// The gateway seam. The money orchestration, the reconcile jobs and the
// admin/store routes call the functions below, which dispatch to the adapter
// for a config's `kind`. Which gateway is ACTIVE is an admin setting
// (site_settings.payment_gateway, see resolveActiveGateway) with
// PAYMENT_GATEWAY as the boot/fallback value.
//
// Naming note: the tables (globepay_deposit / globepay_withdrawal), the
// orchestration files (globepay-deposit.ts / globepay-withdrawal.ts), the
// /admin/globepay/* routes and the GLOBEPAY_ENABLED switches predate the
// seam and kept their names when the GlobePay365 integration itself was
// removed (2026-09-06). They are gateway-neutral; only the names are old.
//
// The orchestration (globepay-deposit.ts, globepay-withdrawal.ts), the
// reconcile jobs and the admin/store routes are gateway-agnostic through this
// file. The inbound hooks are NOT — each gateway signs its callbacks its own
// way, so they live at src/api/hooks/<gateway>/. Adding a gateway = a client
// file, a hooks folder, an entry in GATEWAYS and an adapter below.

export type PaymentGateway = 'tgpay';

export type GatewayDefinition = {
  id: PaymentGateway;
  /** Operator-facing name for the admin switch. */
  label: string;
  /** Are the credentials for this gateway present in the environment? */
  configured: (env: Partial<NodeJS.ProcessEnv>) => boolean;
  /** Its client config from env; throws when `configured` would be false. */
  configFromEnv: (env: NodeJS.ProcessEnv) => GatewayConfig;
  /** Does create-payment/payout need the customer's name/email/phone? */
  needsCustomerContact: boolean;
  /** Their server-to-server callback targets on OUR backend. */
  hooks: { deposit: string; withdrawal: string; payoutVerify?: string };
  /**
   * The gateway's own per-transaction band, RM. Enforced BEFORE any row or
   * gateway call so an amount that cannot succeed never costs a round trip or
   * leaves a failed row behind, and the customer reads the bounds instead of
   * the gateway's bare refusal. Ceilings are additionally capped by our own
   * site-wide TOPUP_MAX_RM / withdrawal daily cap.
   */
  limits: {
    depositMin: number;
    depositMax: number;
    withdrawalMin: number;
    withdrawalMax: number;
  };
};

export const GATEWAYS: Record<PaymentGateway, GatewayDefinition> = {
  tgpay: {
    id: 'tgpay',
    label: 'TGPay',
    configured: (env) => Boolean(env.TGPAY_SECRET_KEY),
    configFromEnv: (env) => tgpay.tgpayConfigFromEnv(env),
    needsCustomerContact: true,
    hooks: {
      deposit: '/hooks/tgpay/deposit',
      withdrawal: '/hooks/tgpay/withdrawal',
    },
    // Read from the PRODUCTION tenant's settings 2026-09-06: FPX / e-wallet /
    // DuitNow RM 50 – 30,000 per transaction, payout RM 50 – 30,000. The
    // deposit ceiling is our own TOPUP_MAX_RM (10,000), the lower of the two.
    limits: {
      depositMin: 50,
      depositMax: 10000,
      withdrawalMin: 50,
      withdrawalMax: 30000,
    },
  },
};

export const GATEWAY_IDS = Object.keys(GATEWAYS) as PaymentGateway[];

/**
 * Gateways that no longer exist in this codebase but whose rows still do.
 * History-only: the audit panel keeps reporting their settled totals, and
 * rowGateway() returns null for their rows so no sweep ever calls them.
 */
export const RETIRED_GATEWAYS: readonly string[] = ['globepay'];

export function isPaymentGateway(value: unknown): value is PaymentGateway {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(GATEWAYS, value)
  );
}

/**
 * The gateway a deposit/withdrawal row belongs to, or null when it names a
 * gateway this deploy does not know — a retired one (every 'globepay' row
 * from before 2026-09-06) or a bad value. The caller must skip or refuse
 * rather than guess: those rows are final history, not live money.
 */
export function rowGateway(row: {
  gateway?: string | null;
}): PaymentGateway | null {
  return isPaymentGateway(row.gateway) ? row.gateway : null;
}

// ---------------------------------------------------------------------------
// Which gateway is active. Read synchronously everywhere (routes, jobs,
// globepayEnabled()) from a process-local cache; refreshed from the DB by
// resolveActiveGateway() at the top of every money entry point, at most once
// per ACTIVE_GATEWAY_TTL_MS. The admin switch writes the row AND the cache,
// so the instance that took the click flips at once; other instances converge
// within one TTL. Money already in flight is unaffected: every deposit and
// withdrawal row carries the gateway it was created under, and the sweeps
// read THAT (gatewayConfigFor), not the active one.

export const ACTIVE_GATEWAY_TTL_MS = 30_000;

let activeSetting: PaymentGateway | null = null;
let activeReadAt = 0;

/** The active gateway: admin setting when known, else PAYMENT_GATEWAY, else TGPay. */
export function paymentGateway(
  env: { PAYMENT_GATEWAY?: string } = process.env,
): PaymentGateway {
  if (activeSetting) return activeSetting;
  return isPaymentGateway(env.PAYMENT_GATEWAY) ? env.PAYMENT_GATEWAY : 'tgpay';
}

/** Set the cached active gateway (admin switch, boot, tests). null = forget. */
export function setActiveGateway(id: PaymentGateway | null): void {
  activeSetting = id;
  activeReadAt = id ? Date.now() : 0;
}

/**
 * Refresh the cache from site_settings if it is older than the TTL. Cheap to
 * call on every request. A DB failure keeps the last known value: a hiccup
 * must not silently flip the gateway back to the env default mid-traffic.
 */
export async function resolveActiveGateway(
  scope: { resolve: <T>(key: string) => T },
  now = Date.now(),
): Promise<PaymentGateway> {
  if (activeReadAt && now - activeReadAt < ACTIVE_GATEWAY_TTL_MS) {
    return paymentGateway();
  }
  try {
    const packs = scope.resolve<{
      siteSettings: () => Promise<{ payment_gateway: string | null }>;
    }>(PACKS_MODULE);
    const { payment_gateway } = await packs.siteSettings();
    activeSetting = isPaymentGateway(payment_gateway) ? payment_gateway : null;
    activeReadAt = now;
  } catch {
    // keep whatever we had
  }
  return paymentGateway();
}

export type GatewayConfig = TgpayConfig;

/** Config for a SPECIFIC gateway, from env. Throws when it is not configured. */
export function gatewayConfigFor(
  id: string,
  env: NodeJS.ProcessEnv = process.env,
): GatewayConfig {
  if (!isPaymentGateway(id))
    throw new Error(`Unknown payment gateway "${id}".`);
  return GATEWAYS[id].configFromEnv(env);
}

/**
 * Config for the gateway a ROW was created under, for the sweeps: memoised
 * per id for the life of one job run, null (never a throw) when that gateway
 * is no longer configured, so one orphaned row cannot stop the whole sweep.
 */
export function rowGatewayConfigs(
  env: NodeJS.ProcessEnv = process.env,
): (gateway: string | null | undefined) => GatewayConfig | null {
  const cache = new Map<string, GatewayConfig | null>();
  return (raw) => {
    const gateway = rowGateway({ gateway: raw });
    if (!gateway) return null;
    if (!cache.has(gateway)) {
      try {
        cache.set(gateway, gatewayConfigFor(gateway, env));
      } catch {
        cache.set(gateway, null);
      }
    }
    return cache.get(gateway) ?? null;
  };
}

/** Config for the ACTIVE gateway. */
export function gatewayConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): GatewayConfig {
  return gatewayConfigFor(paymentGateway(env), env);
}

/**
 * Where a gateway must send its callbacks, and where the customer lands:
 * PAYMENT_CALLBACK_BASE (our public backend origin) + the gateway's hook
 * paths. Missing values come back as '' — callers fail closed on that, so a
 * deploy without the base cannot start a payment nobody could settle.
 */
export function gatewayUrls(
  id: PaymentGateway = paymentGateway(),
  env: NodeJS.ProcessEnv = process.env,
): {
  notifyUrl: string;
  returnUrl: string;
  withdrawNotifyUrl: string;
  /** '' when the gateway has no payout-verification step. */
  payoutVerifyUrl: string;
  hasPayoutVerify: boolean;
} {
  const def = GATEWAYS[id];
  // https only: the gateway posts its key headers to these URLs, and a
  // plain-http base would put those reusable credentials on the wire in the
  // clear. Anything else counts as unset, so the money routes fail closed.
  const raw = env.PAYMENT_CALLBACK_BASE?.trim().replace(/\/+$/, '') ?? '';
  const base = /^https:\/\/[^/\s]+$/i.test(raw) ? raw : '';
  const hook = (path: string | undefined) =>
    path && base ? `${base}${path}` : '';
  return {
    notifyUrl: hook(def.hooks.deposit),
    // PAYMENT_RETURN_URL; the pre-removal name is read until the spec moves.
    returnUrl: env.PAYMENT_RETURN_URL ?? env.GLOBEPAY_RETURN_URL ?? '',
    withdrawNotifyUrl: hook(def.hooks.withdrawal),
    payoutVerifyUrl: hook(def.hooks.payoutVerify),
    hasPayoutVerify: Boolean(def.hooks.payoutVerify),
  };
}

/**
 * Where TGPay's hosted checkout lives when create-payment hands back a
 * relative link ("/checkout?order=…"). Their hosts pair the API with a
 * checkout site — `sandbox-api.` ↔ `sandbox-checkout.`, `api.` ↔ `checkout.`
 * (both verified 2026-09-05/06) — so the fallback swaps that label; any
 * other layout needs TGPAY_CHECKOUT_BASE.
 */
export function tgpayCheckoutBase(
  config: Pick<TgpayConfig, 'baseUrl'>,
  env: { TGPAY_CHECKOUT_BASE?: string } = process.env,
): string {
  if (env.TGPAY_CHECKOUT_BASE)
    return env.TGPAY_CHECKOUT_BASE.replace(/\/+$/, '');
  const { protocol, host } = new URL(config.baseUrl);
  const checkoutHost = host.replace(
    /^(?:([a-z0-9-]+)-)?api\./i,
    (_m, prefix) => (prefix ? `${prefix}-checkout.` : 'checkout.'),
  );
  return `${protocol}//${checkoutHost}`;
}

function absoluteLink(link: string, config: TgpayConfig): string {
  return /^https?:\/\//i.test(link)
    ? link
    : `${tgpayCheckoutBase(config)}${link}`;
}

// ---------------------------------------------------------------------------
// Adapters. One object per gateway with the six operations the money paths
// need, in the neutral shapes of gateway-types.ts. The exported functions
// below only pick the adapter for the config's `kind` — adding a gateway is
// a registry entry PLUS an adapter here, nothing in the orchestration,
// sweeps or routes.

type GatewayAdapter<C extends GatewayConfig> = {
  submitDeposit: (
    input: SubmitDepositInput,
    config: C,
  ) => Promise<SubmitDepositResult>;
  getDepositDetail: (
    merchantTransactionId: string,
    config: C,
  ) => Promise<DepositDetail>;
  submitWithdrawal: (
    input: SubmitWithdrawalInput,
    config: C,
  ) => Promise<SubmitWithdrawalResult>;
  getWithdrawalDetail: (
    merchantTransactionId: string,
    config: C,
  ) => Promise<WithdrawalDetail>;
  getSupportedBanks: (config: C) => Promise<SupportedBank[]>;
  checkBalance: (config: C) => Promise<MerchantBalance>;
};

/**
 * Storefront method codes (BQR / OB, the pre-TGPay rail names the sheet still
 * sends) mapped onto TGPay's two hosted-checkout rails. DN has no hosted equivalent
 * (DuitNow QR is custom-checkout only) and is refused as a definite error.
 */
const TGPAY_METHOD: Record<string, 'FPX' | 'EWALLET' | undefined> = {
  FPX: 'FPX',
  OB: 'FPX',
  BQR: 'EWALLET',
};

const tgpayAdapter: GatewayAdapter<TgpayConfig> = {
  async submitDeposit(input, config) {
    const paymentMethod = TGPAY_METHOD[input.paymentMethodCode];
    if (!paymentMethod) {
      throw new tgpay.TgpayError(
        `TGPay: no hosted-checkout rail for method ${input.paymentMethodCode}`,
        ['TGPAY_UNSUPPORTED_METHOD'],
        400,
        true,
      );
    }
    if (!input.customer) {
      throw new tgpay.TgpayError(
        'TGPay: create-payment needs the customer contact (name/email/phone)',
        ['TGPAY_CUSTOMER_REQUIRED'],
        400,
        true,
      );
    }
    const result = await tgpay.createPayment(
      {
        merchantRefNum: input.merchantTransactionId,
        amount: input.amount,
        notifyUrl: input.notifyUrl,
        redirectUrl: input.returnUrl,
        customer: input.customer,
        paymentMethod,
        // Shown on their checkout and stored on their transaction, so the
        // operator can tie a TGPay row to a customer without opening our
        // admin. The id is opaque (it cannot reach the account), unlike an
        // email.
        additionalData: `Customer ${input.merchantClientId}`,
      },
      config,
    );
    return {
      transactionId: result.order ?? '',
      url: absoluteLink(result.checkoutLink, config),
      depositActualAmount: input.amount,
    };
  },

  async getDepositDetail(merchantTransactionId, config) {
    const q = await tgpay.queryPayment(merchantTransactionId, config);
    return {
      transactionId: q.order,
      merchantTransactionId,
      statusId: null,
      status: q.status,
      amount: Number(q.amount),
      netAmount: Number(q.amountAfterFee),
      paymentMethodCode: q.paymentMethod,
      bankReferenceNo: null,
      uniqueReferenceNo: null,
      state: tgpay.tgpayPaymentState(q.status),
    };
  },

  async submitWithdrawal(input, config) {
    // Canonical id (or any legacy alias) → TGPay's SWIFT code + the exact
    // name TGPay pairs with it. The sandbox dummy bank exists only there.
    const known = findBank(input.destinationBankCode);
    const bank =
      known &&
      (known.id !== TGPAY_SANDBOX_BANK.id || tgpay.tgpayIsSandbox(config))
        ? gatewayBankCode(input.destinationBankCode, 'tgpay')
        : null;
    if (!bank) {
      throw new tgpay.TgpayError(
        `TGPay: cannot pay to bank ${input.destinationBankCode} — not in its SWIFT table`,
        ['TGPAY_UNKNOWN_BANK'],
        400,
        true,
      );
    }
    if (!input.email) {
      throw new tgpay.TgpayError(
        'TGPay: payout needs the customer email',
        ['TGPAY_CUSTOMER_REQUIRED'],
        400,
        true,
      );
    }
    const result = await tgpay.createPayout(
      {
        merchantRefNum: input.merchantTransactionId,
        amount: input.amount,
        email: input.email,
        userName: input.destinationAccountHolderName,
        bankAccNumber: input.destinationAccountNumber,
        bankCode: bank.code,
        bankName: bank.name,
        notifyUrl: input.notifyUrl,
      },
      config,
    );
    return { transactionId: result.transactionRefNum };
  },

  async getWithdrawalDetail(merchantTransactionId, config) {
    const q = await tgpay.queryPayout(merchantTransactionId, config);
    const amount = Number(q.order?.amount);
    return {
      transactionId: q.order?.payoutRefNum ?? '',
      merchantTransactionId,
      statusId: null,
      status: q.status,
      amount,
      // Same rule as the payout callback (money.ts netOfFee); NaN when
      // unknown, which toOptionalMoney turns into NULL on the row.
      netAmount: netOfFee(q.order?.amount, q.order?.fee) ?? NaN,
      paymentMethodCode: 'WD',
      bankReferenceNo: null,
      uniqueReferenceNo: null,
      state: tgpay.tgpayPayoutState(q.status),
    };
  },

  async getSupportedBanks(config) {
    return banksFor('tgpay', { sandbox: tgpay.tgpayIsSandbox(config) });
  },

  /**
   * TGPay keeps two wallets. Pay-in credit is what deposits accrue into
   * (`current`), the payout wallet is what withdrawals draw from
   * (`available`). There is no T+1 concept; it reports 0.
   */
  async checkBalance(config) {
    const b = await tgpay.balances(config);
    return {
      merchantCode: 'tgpay',
      currencyCode: b.currencyCode,
      currentBalance: b.payin,
      availableBalance: b.payout,
      t1Balance: 0,
      notes: b.missing.map(
        (w) =>
          `TGPay has no ${w === 'payin' ? 'pay-in' : 'payout'} wallet for ${b.currencyCode} — shown as 0, actually unknown`,
      ),
    };
  },
};

const ADAPTERS: {
  [K in GatewayConfig['kind']]: GatewayAdapter<GatewayConfig>;
} = { tgpay: tgpayAdapter };

/** Pick the adapter for a config by its `kind`. */
function adapterFor(config: GatewayConfig): GatewayAdapter<GatewayConfig> {
  return ADAPTERS[config.kind];
}

export function submitDeposit(
  input: SubmitDepositInput,
  config: GatewayConfig,
): Promise<SubmitDepositResult> {
  return adapterFor(config).submitDeposit(input, config);
}

export function getDepositDetail(
  merchantTransactionId: string,
  config: GatewayConfig,
): Promise<DepositDetail> {
  return adapterFor(config).getDepositDetail(merchantTransactionId, config);
}

export function submitWithdrawal(
  input: SubmitWithdrawalInput,
  config: GatewayConfig,
): Promise<SubmitWithdrawalResult> {
  return adapterFor(config).submitWithdrawal(input, config);
}

export function getWithdrawalDetail(
  merchantTransactionId: string,
  config: GatewayConfig,
): Promise<WithdrawalDetail> {
  return adapterFor(config).getWithdrawalDetail(merchantTransactionId, config);
}

export function getSupportedBanks(
  config: GatewayConfig,
): Promise<SupportedBank[]> {
  return adapterFor(config).getSupportedBanks(config);
}

export function checkBalance(config: GatewayConfig): Promise<MerchantBalance> {
  return adapterFor(config).checkBalance(config);
}

export { TgpayError, TGPAY_NOT_FOUND } from './tgpay-client';

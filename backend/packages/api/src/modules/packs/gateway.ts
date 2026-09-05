import * as globepay from './globepay-client';
import * as tgpay from './tgpay-client';
import type { SettlementState } from './globepay';
import type { GlobePayConfig } from './globepay-client';
import type { TgpayConfig, TgpayCustomer } from './tgpay-client';
import { PACKS_MODULE } from './index';
import {
  banksFor,
  findBank,
  gatewayBankCode,
  TGPAY_SANDBOX_BANK,
} from './banks';
import { netOfFee } from './money';

// The gateway seam. Every caller that used to import the HTTP client from
// globepay-client imports it from here instead; the functions keep GlobePay's
// signatures and dispatch on the ACTIVE gateway. Which one is active is an
// admin setting (site_settings.payment_gateway, see resolveActiveGateway)
// with PAYMENT_GATEWAY as the boot/fallback value; unset means GlobePay, so a
// deploy that never heard of the switch behaves exactly as before.
//
// The orchestration (globepay-deposit.ts, globepay-withdrawal.ts), the
// reconcile jobs and the admin/store routes are gateway-agnostic through this
// file. The inbound hooks are NOT — each gateway signs its callbacks its own
// way, so they live at src/api/hooks/<gateway>/. Adding a gateway = a client
// file, a hooks folder, an entry in GATEWAYS and an adapter below.

export type PaymentGateway = 'globepay' | 'tgpay';

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
  globepay: {
    id: 'globepay',
    label: 'GlobePay365',
    configured: (env) => Boolean(env.GLOBEPAY_MERCHANT_CODE),
    configFromEnv: (env) => globepay.globepayConfigFromEnv(env),
    needsCustomerContact: false,
    hooks: {
      deposit: '/hooks/globepay/deposit',
      withdrawal: '/hooks/globepay/withdrawal',
      payoutVerify: '/hooks/globepay/payout-verify',
    },
    // Production merchant band confirmed by the provider 2026-07-29 (deposits)
    // and the WD channel's documented range (withdrawals).
    limits: {
      depositMin: 30,
      depositMax: 10000,
      withdrawalMin: 50,
      withdrawalMax: 50000,
    },
  },
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

export function isPaymentGateway(value: unknown): value is PaymentGateway {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(GATEWAYS, value)
  );
}

/**
 * The gateway a deposit/withdrawal row belongs to. A row with no value (the
 * column's default, a pre-migration read, an old test fixture) is GlobePay —
 * the only gateway that ever wrote rows before the switch existed. An
 * unregistered value is null: the caller must refuse rather than guess.
 */
export function rowGateway(row: {
  gateway?: string | null;
}): PaymentGateway | null {
  if (row.gateway == null || row.gateway === '') return 'globepay';
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

/** The active gateway: admin setting when known, else PAYMENT_GATEWAY, else GlobePay. */
export function paymentGateway(
  env: { PAYMENT_GATEWAY?: string } = process.env,
): PaymentGateway {
  if (activeSetting) return activeSetting;
  return isPaymentGateway(env.PAYMENT_GATEWAY)
    ? env.PAYMENT_GATEWAY
    : 'globepay';
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

export type GatewayConfig = GlobePayConfig | TgpayConfig;

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
 * Where a gateway must send its callbacks, and where the customer lands.
 * PAYMENT_CALLBACK_BASE (our public backend origin) + the gateway's hook
 * paths; without it, the explicit GLOBEPAY_*_URL values apply unchanged, so
 * a production deploy that predates the switch keeps its exact URLs.
 * Missing values come back as '' — callers fail closed on that, as before.
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
  const base = env.PAYMENT_CALLBACK_BASE?.replace(/\/+$/, '');
  // An explicit URL is honoured only when it points at THIS gateway's hook.
  // Production predates the switch and names the GlobePay hooks explicitly;
  // handing those to TGPay would send every callback to a route that rejects
  // it. Better to fail closed ('' → "temporarily unavailable") than misroute.
  const hook = (path: string | undefined, explicit: string | undefined) => {
    if (path && base) return `${base}${path}`;
    if (path && explicit && explicit.replace(/\/+$/, '').endsWith(path)) {
      return explicit;
    }
    return '';
  };
  return {
    notifyUrl: hook(def.hooks.deposit, env.GLOBEPAY_NOTIFY_URL),
    returnUrl: env.GLOBEPAY_RETURN_URL ?? '',
    withdrawNotifyUrl: hook(
      def.hooks.withdrawal,
      env.GLOBEPAY_WITHDRAW_NOTIFY_URL,
    ),
    payoutVerifyUrl: def.hooks.payoutVerify
      ? hook(def.hooks.payoutVerify, env.GLOBEPAY_PAYOUT_VERIFY_URL)
      : '',
    hasPayoutVerify: Boolean(def.hooks.payoutVerify),
  };
}

function isTgpay(config: GatewayConfig): config is TgpayConfig {
  return 'kind' in config && config.kind === 'tgpay';
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
// need, all in GlobePay's shapes. The exported functions below only pick the
// adapter for the config's `kind` — adding a gateway is a registry entry
// PLUS an adapter here, nothing in the orchestration, sweeps or routes.

export type SubmitDepositInput = globepay.SubmitDepositInput & {
  /** Required by TGPay's create-payment; ignored by GlobePay. */
  customer?: TgpayCustomer;
};
export type SubmitDepositResult = globepay.SubmitDepositResult;

export type DepositDetail = Omit<globepay.DepositDetail, 'statusId'> & {
  /** GlobePay's numeric code; null for TGPay, whose statuses are strings. */
  statusId: number | null;
  state: SettlementState;
};

export type SubmitWithdrawalInput = globepay.SubmitWithdrawalInput & {
  /** Required by TGPay's payout; ignored by GlobePay. */
  email?: string;
};
export type SubmitWithdrawalResult = globepay.SubmitWithdrawalResult;

export type WithdrawalDetail = Omit<globepay.WithdrawalDetail, 'statusId'> & {
  statusId: number | null;
  state: SettlementState;
};

export type SupportedBank = globepay.SupportedBank;

export type MerchantBalance = globepay.MerchantBalance & {
  /** Human-readable caveats (e.g. a wallet the gateway has no row for). */
  notes?: string[];
};

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

const globepayAdapter: GatewayAdapter<GlobePayConfig> = {
  submitDeposit: globepay.submitDeposit,
  getDepositDetail: globepay.getDepositDetail,
  // Saved accounts and rows carry the canonical bank id; GlobePay wants its
  // own code. A code the registry does not know passes through untouched —
  // that is exactly what every pre-registry row and metadata entry carries,
  // and GlobePay is the gateway that issued it. A bank the registry KNOWS
  // but GlobePay cannot pay to (Citibank, KFH, the TGPay sandbox bank) is a
  // definite refusal: passing its canonical id through would be a misroute.
  // async so a refusal is a rejection, like every other adapter error.
  submitWithdrawal: async (input, config) => {
    const known = findBank(input.destinationBankCode);
    const own = gatewayBankCode(input.destinationBankCode, 'globepay');
    if (known && !own) {
      throw new globepay.GlobePayError(
        `GlobePay365: cannot pay to bank ${input.destinationBankCode} — not in its supported list`,
        ['GLOBEPAY_UNKNOWN_BANK'],
        400,
        true,
      );
    }
    return globepay.submitWithdrawal(
      { ...input, destinationBankCode: own?.code ?? input.destinationBankCode },
      config,
    );
  },
  getWithdrawalDetail: globepay.getWithdrawalDetail,
  // Still the LIVE GetSupportedBanks, as before the registry — a bank
  // GlobePay adds or drops must show up without a deploy — with each entry
  // translated to its canonical id so the picker hands out the same ids
  // under every gateway. A code the registry does not know passes through
  // (GlobePay can pay to it; bankSupportedBy treats it as GlobePay's own).
  // If the live call fails the registry snapshot stands in, so a gateway
  // hiccup never blanks the picker.
  getSupportedBanks: async (config) => {
    try {
      const live = await globepay.getSupportedBanks(config);
      return live.map((b) => {
        const known = findBank(b.bankCode);
        return known
          ? { bankCode: known.id, bankName: known.name }
          : { bankCode: b.bankCode, bankName: b.bankName };
      });
    } catch {
      return banksFor('globepay');
    }
  },
  checkBalance: globepay.checkBalance,
};

/**
 * Storefront method codes (BQR / OB, plus the wider GlobePay MYR set) mapped
 * onto TGPay's two hosted-checkout rails. DN has no hosted equivalent
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

/**
 * Pick the adapter for a config. GlobePay configs carry no `kind`. The
 * adapters are typed against their own config; the union-typed call through
 * here is sound because `kind` is exactly what selected them.
 */
function adapterFor(config: GatewayConfig): GatewayAdapter<GatewayConfig> {
  return (isTgpay(config)
    ? tgpayAdapter
    : globepayAdapter) as unknown as GatewayAdapter<GatewayConfig>;
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

export { GlobePayError } from './globepay-client';
export { TgpayError, TGPAY_NOT_FOUND } from './tgpay-client';

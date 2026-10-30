import * as tgpay from './tgpay-client';
import {
  TGPAY_FAMILY,
  tgpayEnvName,
  type TgpayConfig,
  type TgpayKind,
} from './tgpay-client';
import { fakeGateway, type FakeConfig } from './fake-gateway';
import * as a3pay from './a3pay-client';
import type { A3payConfig } from './a3pay-client';
import { toLedgerAmount, type RowFx } from './payment-fx';
import { gatewayEnv } from './gateway-env';
import { PACKS_MODULE } from './index';
import {
  banksFor,
  findBank,
  gatewayBankCode,
  TGPAY_SANDBOX_BANK,
} from './banks';
import { LEDGER_CURRENCY, payoutCost, toOptionalMoney } from './money';
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
// Naming note: the tables (gateway_deposit / gateway_withdrawal), the
// orchestration files (gateway-deposit.ts / gateway-withdrawal.ts), the
// /admin/payments/* routes and the GATEWAY_* switches are gateway-neutral.
// They carried the first gateway's name until 2026-09-07 (operator: "we no
// longer use GlobePay, remove it"); the old GLOBEPAY_* env names are still
// read as a fallback (gateway-env.ts) until the production spec moves.
//
// The orchestration (gateway-deposit.ts, gateway-withdrawal.ts), the
// reconcile jobs and the admin/store routes are gateway-agnostic through this
// file. The inbound hooks are NOT — each gateway signs its callbacks its own
// way, so they live at src/api/hooks/<gateway>/. Adding a gateway = a client
// file, a hooks folder, an entry in GATEWAYS and an adapter below.

// 'fake' is the in-process adapter the specs drive (fake-gateway.ts). It is
// in the union so the compiler forces a registry entry AND an adapter for it
// like any other gateway, and it is unreachable outside NODE_ENV=test: see
// testOnly() below, which gates isPaymentGateway (and therefore
// gatewayConfigFor, resolveActiveGateway and the admin switch), plus the
// registry entry's own `configured` / `configFromEnv`.
export type PaymentGateway = 'tgpay' | 'the7pay' | 'a3pay' | 'gp365' | 'fake';

export { LEDGER_CURRENCY };

export type GatewayDefinition = {
  id: PaymentGateway;
  /** Operator-facing name for the admin switch. */
  label: string;
  /**
   * The currency the gateway moves. LEDGER_CURRENCY (MYR) gateways are the
   * ones the admin switch chooses between; any other is a REGIONAL rail that
   * runs beside the active one (A3Pay for Singapore), is chosen by the
   * customer's currency or payout bank, and converts through payment-fx.ts.
   */
  currency: string;
  /**
   * A regional gateway's own band, in ITS currency. The RM `limits` below
   * still apply to the converted amount — they are what the ledger fences.
   */
  currencyLimits?: {
    depositMin: number;
    depositMax: number;
    withdrawalMin: number;
    withdrawalMax: number;
  };
  /**
   * A regional gateway's own fee per payout, in percent, taken from OUR float
   * on top of the amount paid out. The float pre-check must cover both.
   */
  payoutFeePercent?: number;
  /** A flat fee per payout on top of the percent, in the gateway's currency
   *  (GlobePay365's 1 USDT gas). Also taken from our float. */
  payoutFlatFee?: number;
  /** Are the credentials for this gateway present in the environment? */
  configured: (env: Partial<NodeJS.ProcessEnv>) => boolean;
  /** Its client config from env; throws when `configured` would be false. */
  configFromEnv: (env: NodeJS.ProcessEnv) => GatewayConfig;
  /** Does create-payment/payout need the customer's name/email/phone? */
  needsCustomerContact: boolean;
  /**
   * A regional gateway's pay-in channels, in the rail codes the storefront
   * sends (startDeposit refuses any other before a row is written).
   */
  depositMethods?: readonly string[];
  /** Must a pay-in name the PAYING account's holder (A3Pay matches it)? */
  needsPayerName?: boolean;
  /**
   * How far (cents of its currency) the gateway may move a payin from what
   * we asked and still be the same deposit at the same rate (payment-fx.ts
   * nudgedDeposit / callbackLedgerAmount). Default PAYIN_NUDGE_CENTS.
   */
  payinNudgeCents?: number;
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
    currency: LEDGER_CURRENCY,
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

  // The backup gateway: a white-label of TGPay's platform (docs/payments/
  // the7pay-api.md), so it shares TGPay's client and adapter with its own
  // keys (THE7PAY_*), host and callback paths.
  the7pay: {
    id: 'the7pay',
    label: 'The 7 Pay',
    currency: LEDGER_CURRENCY,
    configured: (env) => Boolean(env.THE7PAY_SECRET_KEY),
    configFromEnv: (env) => tgpay.tgpayFamilyConfigFromEnv('the7pay', env),
    needsCustomerContact: true,
    hooks: {
      deposit: '/hooks/the7pay/deposit',
      withdrawal: '/hooks/the7pay/withdrawal',
    },
    // Production tenant settings read 2026-10-09: payout RM 100 – 30,000 per
    // request. Its pay-in min/max are blank ("platform defaults", not shown);
    // the deposit band assumes the platform default TGPay's production tenant
    // shows (RM 50 – 30,000) under our own TOPUP_MAX_RM — confirm with 7Pay.
    limits: {
      depositMin: 50,
      depositMax: 10000,
      withdrawalMin: 100,
      withdrawalMax: 30000,
    },
  },

  // Singapore (SGD), beside the active RM gateway — never instead of it.
  // `configured` also requires A3PAY_ENABLED=true, so credentials can be
  // deployed ahead of opening the rail; the sweeps read configFromEnv, not
  // `configured`, so rows already in flight still settle after a switch-off.
  a3pay: {
    id: 'a3pay',
    label: 'A3Pay (SGD)',
    currency: 'SGD',
    configured: (env) =>
      env.A3PAY_ENABLED === 'true' && a3pay.a3payConfigured(env),
    configFromEnv: (env) => a3pay.a3payConfigFromEnv(env),
    // FromCustomerAccountHolderName is mandatory for SGD. The deposit route
    // fills it from what the customer already gave us (a saved Singapore
    // account's holder, else the verified real name) — the sheet does not
    // ask — so this gateway needs no profile contact.
    needsCustomerContact: false,
    depositMethods: ['OB', 'BQR'],
    needsPayerName: true,
    hooks: {
      deposit: '/hooks/a3pay/deposit',
      withdrawal: '/hooks/a3pay/withdrawal',
      payoutVerify: '/hooks/a3pay/payout-verify',
    },
    // RM fences on the CONVERTED amount, plus A3Pay's own SGD band — read from the back office
    // (Merchant Transaction Setting, 2026-10-12): deposit OB / BQR S$10 –
    // 5,000 (2.5% fee), payout WD S$50 – 10,000 (1.5% fee). The top-up band
    // is further narrowed at quote time so the RM credit fits the RM band
    // (payment-fx.ts regionalDepositBand). OUR top-up floor is S$30, above
    // A3Pay's S$10 (operator decision, 2026-10-12). The payout floor is S$30:
    // A3Pay lowered its WD minimum from S$50 for us on 2026-10-12.
    // The top-up RM ceiling is NOT the RM gateway's 10,000 (operator
    // decision, 2026-10-14): S$ top-ups go up to A3Pay's own S$5,000, about
    // RM 15,850 at 3.17. 20,000 admits S$5,000 plus a nudge at any rate under
    // RM 4 per S$; above that, regionalDepositBand narrows the S$ band.
    limits: {
      depositMin: 30,
      depositMax: 20000,
      withdrawalMin: 50,
      withdrawalMax: 30000,
    },
    currencyLimits: {
      depositMin: 30,
      depositMax: 5000,
      withdrawalMin: 30,
      withdrawalMax: 10000,
    },
    // WD 1.5% (back office, above): a S$50.79 payout cost S$51.55 live.
    payoutFeePercent: 1.5,
  },

  // USDT, beside the active RM gateway like A3Pay — and on the same platform
  // (GlobePay365 publishes A3Pay's handbook under its own name), so it shares
  // A3Pay's client, adapter and hook handlers with its own GP365_* keys, host
  // and callback paths. NOT the retired 'globepay' (RETIRED_GATEWAYS): that
  // id names the old MYR merchant's rows, which must stay history.
  gp365: {
    id: 'gp365',
    label: 'GlobePay365 (USDT)',
    currency: 'USDT',
    configured: (env) =>
      env.GP365_ENABLED === 'true' && a3pay.a3payFamilyConfigured('gp365', env),
    configFromEnv: (env) => a3pay.a3payFamilyConfigFromEnv('gp365', env),
    needsCustomerContact: false,
    // UTRC = USDT on Tron (TRC20). No payer name: the doc requires
    // FromCustomerAccountHolderName for SGD only. UERC (ERC20) is withdrawn:
    // production CreatePayin refuses it ("unknown error"; all 3 live attempts
    // and a test on 2026-10-26), so offering it only strands customers.
    // Re-add it here and in the storefront rail once GlobePay365 opens it.
    depositMethods: ['UTRC'],
    needsPayerName: false,
    // PROVISIONAL, up to 1 USDT: crypto cashiers make amounts unique with
    // larger tails than A3Pay's cent. Measure payinActualAmount on staging.
    payinNudgeCents: 100,
    hooks: {
      deposit: '/hooks/gp365/deposit',
      withdrawal: '/hooks/gp365/withdrawal',
      payoutVerify: '/hooks/gp365/payout-verify',
    },
    // GlobePay365's own payout cost (2026-10-21): 0.2% + 1 USDT gas.
    payoutFeePercent: 0.2,
    payoutFlatFee: 1,
    // RM fences on the converted amount, as for A3Pay. GlobePay365 itself
    // takes 3 USDT and up with no maximum (2026-10-21); our band is tighter.
    // Payouts start at 60 USDT so the 2% withdrawal fee covers the 1 USDT gas.
    limits: {
      depositMin: 30,
      depositMax: 10000,
      // Under USDT 60 (~RM 250) so the USDT floor, not this one, binds.
      withdrawalMin: 30,
      withdrawalMax: 30000,
    },
    currencyLimits: {
      depositMin: 10,
      depositMax: 2000,
      withdrawalMin: 60,
      withdrawalMax: 5000,
    },
  },

  // Test-only. Mirrors TGPay's limits and contact requirement field for
  // field, so a spec that selects it exercises the SAME orchestration
  // branches the production gateway takes — only the I/O is replaced. Its
  // hook paths are real strings (nothing serves them) because gatewayUrls
  // returns '' for an empty path and the money routes fail closed on that.
  fake: {
    id: 'fake',
    label: 'Fake gateway (tests)',
    currency: LEDGER_CURRENCY,
    configured: () => testOnly(),
    configFromEnv: () => {
      if (!testOnly())
        throw new Error(
          'The fake payment gateway is available under NODE_ENV=test only.',
        );
      return { kind: 'fake' };
    },
    needsCustomerContact: true,
    hooks: {
      deposit: '/hooks/fake/deposit',
      withdrawal: '/hooks/fake/withdrawal',
    },
    limits: {
      depositMin: 50,
      depositMax: 10000,
      withdrawalMin: 50,
      withdrawalMax: 30000,
    },
  },
};

/**
 * The gateways an OPERATOR may be shown and may choose. Never the fake, in
 * any environment — a test selects it by env or by setActiveGateway, not from
 * the admin switch, and this list is also what the audit page walks.
 */
export const GATEWAY_IDS = (Object.keys(GATEWAYS) as PaymentGateway[]).filter(
  (id) => id !== 'fake',
);

/** Does this gateway move RM (as opposed to a regional currency)? */
export function isLedgerGateway(id: PaymentGateway): boolean {
  return GATEWAYS[id].currency === LEDGER_CURRENCY;
}

/**
 * The gateways the admin switch may make ACTIVE: RM ones only. A regional
 * gateway (A3Pay) runs beside the active one; making it active would send
 * every RM top-up to an SGD rail.
 */
export const LEDGER_GATEWAY_IDS = GATEWAY_IDS.filter(isLedgerGateway);

/** Every currency a regional gateway settles in (today: SGD). */
export const REGIONAL_CURRENCIES = [
  ...new Set(
    GATEWAY_IDS.filter((id) => !isLedgerGateway(id)).map(
      (id) => GATEWAYS[id].currency,
    ),
  ),
];

/** Every currency the admin Settlement page has a tab for: RM first. */
export const PAYMENT_CURRENCIES = [LEDGER_CURRENCY, ...REGIONAL_CURRENCIES];

/** The gateways that move `currency`, in registry order. */
export function gatewaysFor(currency: string): PaymentGateway[] {
  return GATEWAY_IDS.filter((id) => GATEWAYS[id].currency === currency);
}

/** The fake gateway exists for specs; nothing else may ever select it. */
function testOnly(): boolean {
  return process.env.NODE_ENV === 'test';
}

/**
 * Gateways that no longer exist in this codebase but whose rows still do.
 * History-only: the audit panel keeps reporting their settled totals, and
 * rowGateway() returns null for their rows so no sweep ever calls them.
 */
export const RETIRED_GATEWAYS: readonly string[] = ['globepay'];

export function isPaymentGateway(value: unknown): value is PaymentGateway {
  if (
    typeof value !== 'string' ||
    !Object.prototype.hasOwnProperty.call(GATEWAYS, value)
  )
    return false;
  // THE guard. Every road to an adapter runs through here — the admin switch,
  // gatewayConfigFor, resolveActiveGateway, paymentGateway(env), rowGateway —
  // so a deploy that is not `test` cannot name the fake by env var, by admin
  // click, or by a row someone wrote 'fake' into.
  return value !== 'fake' || testOnly();
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
// gatewayEnabled()) from a process-local cache; refreshed from the DB by
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
  return isPaymentGateway(env.PAYMENT_GATEWAY) &&
    isLedgerGateway(env.PAYMENT_GATEWAY)
    ? env.PAYMENT_GATEWAY
    : 'tgpay';
}

/** Set the cached active gateway (admin switch, boot, tests). null = forget. */
export function setActiveGateway(id: PaymentGateway | null): void {
  // THE guard for the active slot: only an RM gateway may hold it. A regional
  // one (A3Pay, SGD) here would route every RM top-up to an SGD rail for up
  // to a TTL — whoever the caller is.
  if (id !== null && !isLedgerGateway(id)) {
    throw new Error(
      `${id} settles in ${GATEWAYS[id].currency}; only an RM gateway can be the active one.`,
    );
  }
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
    activeSetting =
      isPaymentGateway(payment_gateway) && isLedgerGateway(payment_gateway)
        ? payment_gateway
        : null;
    activeReadAt = now;
  } catch {
    // keep whatever we had
  }
  return paymentGateway();
}

export type GatewayConfig =
  | TgpayConfig<'tgpay'>
  | TgpayConfig<'the7pay'>
  | A3payConfig<'a3pay'>
  | A3payConfig<'gp365'>
  | FakeConfig;

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
    // PAYMENT_RETURN_URL, or its legacy name until the spec moves (gateway-env).
    returnUrl: gatewayEnv('PAYMENT_RETURN_URL', env) ?? '',
    withdrawNotifyUrl: hook(def.hooks.withdrawal),
    payoutVerifyUrl: hook(def.hooks.payoutVerify),
    hasPayoutVerify: Boolean(def.hooks.payoutVerify),
  };
}

/**
 * Where TGPay's hosted checkout lives when create-payment hands back a
 * relative link ("/checkout?order=…"). Their hosts pair the API with a
 * checkout site — `sandbox-api.` ↔ `sandbox-checkout.`, `api.` ↔ `checkout.`
 * (both verified 2026-09-05/06; The 7 Pay documents the same pairing) — so
 * the fallback swaps that label; any other layout needs
 * <PREFIX>_CHECKOUT_BASE (TGPAY_CHECKOUT_BASE, THE7PAY_CHECKOUT_BASE).
 */
export function tgpayCheckoutBase(
  config: Pick<TgpayConfig, 'baseUrl'> & { kind?: TgpayKind },
  env: Partial<Record<string, string>> = process.env,
): string {
  const override = env[tgpayEnvName(config.kind ?? 'tgpay', 'CHECKOUT_BASE')];
  if (override) return override.replace(/\/+$/, '');
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

export type GatewayAdapter<C extends GatewayConfig> = {
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

// One adapter for the whole TGPay platform family: `config.kind` picks the
// label, the bank-code column and the env prefix; the wire format is shared.
const tgpayAdapter: GatewayAdapter<TgpayConfig> = {
  async submitDeposit(input, config) {
    const label = TGPAY_FAMILY[config.kind].label;
    const paymentMethod = TGPAY_METHOD[input.paymentMethodCode];
    if (!paymentMethod) {
      throw new tgpay.TgpayError(
        `${label}: no hosted-checkout rail for method ${input.paymentMethodCode}`,
        ['TGPAY_UNSUPPORTED_METHOD'],
        400,
        true,
      );
    }
    if (!input.customer) {
      throw new tgpay.TgpayError(
        `${label}: create-payment needs the customer contact (name/email/phone)`,
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
    const label = TGPAY_FAMILY[config.kind].label;
    // Canonical id (or any legacy alias) → TGPay's SWIFT code + the exact
    // name TGPay pairs with it. The sandbox dummy bank exists only there.
    const known = findBank(input.destinationBankCode);
    const bank =
      known &&
      (known.id !== TGPAY_SANDBOX_BANK.id || tgpay.tgpayIsSandbox(config))
        ? gatewayBankCode(input.destinationBankCode, config.kind)
        : null;
    if (!bank) {
      throw new tgpay.TgpayError(
        `${label}: cannot pay to bank ${input.destinationBankCode} — not in its SWIFT table`,
        ['TGPAY_UNKNOWN_BANK'],
        400,
        true,
      );
    }
    if (!input.email) {
      throw new tgpay.TgpayError(
        `${label}: payout needs the customer email`,
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
      // Same rule as the payout callback (money.ts payoutCost): a payout's
      // net is what the wallet PAID. `amountIncludeFee` is what their wallet
      // page shows; the sum is the same number when both parts are present
      // (verified on the sandbox: 50 + 1 = 51). NaN when unknown, which
      // toOptionalMoney turns into NULL on the row.
      netAmount:
        toOptionalMoney(q.order?.amountIncludeFee) ??
        payoutCost(q.order?.amount, q.order?.fee) ??
        NaN,
      paymentMethodCode: 'WD',
      bankReferenceNo: null,
      uniqueReferenceNo: null,
      state: tgpay.tgpayPayoutState(q.status),
    };
  },

  async getSupportedBanks(config) {
    return banksFor(config.kind, { sandbox: tgpay.tgpayIsSandbox(config) });
  },

  /**
   * TGPay keeps two wallets. Pay-in credit is what deposits accrue into
   * (`current`), the payout wallet is what withdrawals draw from
   * (`available`). There is no T+1 concept; it reports 0.
   */
  async checkBalance(config) {
    const b = await tgpay.balances(config);
    return {
      merchantCode: config.kind,
      currencyCode: b.currencyCode,
      currentBalance: b.payin,
      availableBalance: b.payout,
      t1Balance: 0,
      notes: b.missing.map(
        (w) =>
          `${TGPAY_FAMILY[config.kind].label} has no ${w === 'payin' ? 'pay-in' : 'payout'} wallet for ${b.currencyCode} — shown as 0, actually unknown`,
      ),
    };
  },
};

// Total over the kinds by construction: a new member of the GatewayConfig
// union has no entry here until someone writes its adapter, and the compiler
// says so.
/** A definite refusal raised before any call — nothing exists on their side. */
function a3payRefusal(
  config: A3payConfig,
  message: string,
  code: string,
): a3pay.A3payError {
  return new a3pay.A3payError(
    `${a3pay.A3PAY_FAMILY[config.kind].label}: ${message}`,
    [code],
    400,
    true,
  );
}

// One adapter for every tenant of the A3Pay platform (A3Pay SGD, GlobePay365
// USDT): `config.kind` is the gateway id, so its registry entry supplies the
// channels and the payer-name rule; the wire format is shared.
const a3payAdapter: GatewayAdapter<A3payConfig> = {
  async submitDeposit(input, config) {
    const def = GATEWAYS[config.kind];
    if (!def.depositMethods?.includes(input.paymentMethodCode)) {
      throw a3payRefusal(
        config,
        `no rail for method ${input.paymentMethodCode}`,
        'A3PAY_UNSUPPORTED_METHOD',
      );
    }
    // The gateway-currency amount comes from the row's FX lock. Never fall
    // back to `amount`: that is RM, and sending it as SGD would charge ~3.3x.
    if (!(input.gatewayAmount && input.gatewayAmount > 0)) {
      throw a3payRefusal(
        config,
        `no ${config.currencyCode} amount on the deposit`,
        'A3PAY_NO_GATEWAY_AMOUNT',
      );
    }
    const payerName = input.payerName?.trim() ?? '';
    if (def.needsPayerName && !payerName) {
      throw a3payRefusal(
        config,
        `${config.currencyCode} payins need the paying account holder name`,
        'A3PAY_PAYER_REQUIRED',
      );
    }
    const r = await a3pay.createPayin(
      {
        merchantTransactionId: input.merchantTransactionId,
        customerId: input.merchantClientId,
        amount: input.gatewayAmount,
        ipAddress: input.ipAddress,
        callbackUrl: input.notifyUrl,
        returnUrl: input.returnUrl,
        paymentMethodId: input.paymentMethodCode,
        ...(def.needsPayerName ? { accountHolderName: payerName } : {}),
      },
      config,
    );
    return {
      transactionId: r.paymentOrderId ?? '',
      url: r.paymentURL,
      bankCode: r.paymentBankCode,
      accountNumber: r.paymentAccountNumber,
      accountHolderName: r.paymentAccountHolderName,
      referenceNo: r.paymentReferenceNo,
      qrCode: r.paymentQRCode,
      depositActualAmount: Number(r.payinActualAmount),
      deepLink: r.paymentDeepLink,
    };
  },

  async getDepositDetail(merchantTransactionId, config) {
    const d = await a3pay.getPayinDetail(merchantTransactionId, config);
    return {
      transactionId: d.paymentOrderId,
      merchantTransactionId,
      statusId: Number(d.statusId),
      status: d.status,
      amount: Number(d.payinAmount),
      netAmount: Number(d.payinNetAmount),
      paymentMethodCode: d.paymentMethodId,
      bankReferenceNo: null,
      uniqueReferenceNo: null,
      state: d.state,
    };
  },

  async submitWithdrawal(input, config) {
    if (!(input.gatewayAmount && input.gatewayAmount > 0)) {
      throw a3payRefusal(
        config,
        `no ${config.currencyCode} amount on the payout`,
        'A3PAY_NO_GATEWAY_AMOUNT',
      );
    }
    const bank = gatewayBankCode(input.destinationBankCode, config.kind);
    if (!bank) {
      throw a3payRefusal(
        config,
        `cannot pay to bank ${input.destinationBankCode}`,
        'A3PAY_UNKNOWN_BANK',
      );
    }
    const r = await a3pay.submitPayout(
      {
        merchantTransactionId: input.merchantTransactionId,
        customerId: input.merchantClientId,
        amount: input.gatewayAmount,
        ipAddress: input.ipAddress,
        bankCode: bank.code,
        accountNumber: input.destinationAccountNumber,
        // A wallet has no holder: GlobePay365 wants MCustId repeated here.
        accountHolderName: findBank(input.destinationBankCode)?.wallet
          ? input.merchantClientId
          : input.destinationAccountHolderName,
        callbackUrl: input.notifyUrl,
        verifyUrl: input.returnUrl,
      },
      config,
    );
    return { transactionId: r.paymentOrderId ?? '' };
  },

  async getWithdrawalDetail(merchantTransactionId, config) {
    const d = await a3pay.getPayoutDetail(merchantTransactionId, config);
    return {
      transactionId: d.paymentOrderId ?? '',
      merchantTransactionId,
      statusId: Number(d.statusId),
      status: d.status,
      amount: Number(d.payoutAmount),
      // What the wallet PAID (amount + their fee) — the payout-net rule.
      netAmount: Number(d.payoutNetAmount),
      paymentMethodCode: d.paymentMethodId,
      bankReferenceNo: null,
      uniqueReferenceNo: null,
      state: d.state,
    };
  },

  async getSupportedBanks(config) {
    return banksFor(config.kind);
  },

  async checkBalance(config) {
    const b = await a3pay.checkAccBalance(config);
    return {
      merchantCode: b.mid ?? b.mID ?? config.merchantCode,
      currencyCode: b.currCode ?? config.currencyCode,
      currentBalance: Number(b.currentBalanceAmount),
      availableBalance: Number(b.availableBalanceAmount),
      t1Balance: Number(b.t1BalanceAmount ?? 0),
    };
  },
};

const ADAPTERS: {
  [K in GatewayConfig['kind']]: GatewayAdapter<
    Extract<GatewayConfig, { kind: K }>
  >;
} = {
  tgpay: tgpayAdapter,
  the7pay: tgpayAdapter,
  a3pay: a3payAdapter,
  gp365: a3payAdapter,
  fake: fakeGateway,
};

/**
 * Pick the adapter for a config by its `kind`. The cast re-widens what the
 * lookup narrowed: each adapter accepts only ITS config (that is what makes
 * the table above type-safe), and the runtime pairing of kind to adapter is
 * exactly what guarantees the config handed on is the one it expects.
 */
function adapterFor(config: GatewayConfig): GatewayAdapter<GatewayConfig> {
  return ADAPTERS[config.kind] as GatewayAdapter<GatewayConfig>;
}

export function submitDeposit(
  input: SubmitDepositInput,
  config: GatewayConfig,
): Promise<SubmitDepositResult> {
  return adapterFor(config).submitDeposit(input, config);
}

/**
 * Requery a row in the currency it was CREATED in, not whatever the config
 * says today. A3Pay answers "Not found" for a CurrCode that does not match
 * the transaction, and "Not found" now authorises a stale-payout refund — so
 * a later A3PAY_CURRENCY edit must not turn live payouts into refunds. Rows
 * from before the column (currency absent) keep the config's currency.
 */
export function inRowCurrency(config: GatewayConfig, fx: RowFx): GatewayConfig {
  const currency = typeof fx.currency === 'string' ? fx.currency : '';
  return currency &&
    'currencyCode' in config &&
    config.currencyCode !== currency
    ? { ...config, currencyCode: currency }
    : config;
}

/**
 * The gateway's record, its amounts converted into RM through the ROW's FX
 * lock. `fx` is REQUIRED, not optional: every caller holds the row, and a call
 * site that forgot it would credit S$ figures as RM. An RM row passes
 * rowFx(row) all the same — it carries no gateway_amount and converts 1:1.
 */
export async function getDepositDetail(
  merchantTransactionId: string,
  config: GatewayConfig,
  fx: RowFx,
): Promise<DepositDetail & { reportedAmount: number }> {
  const asked = inRowCurrency(config, fx);
  const d = await adapterFor(asked).getDepositDetail(
    merchantTransactionId,
    asked,
  );
  return {
    ...d,
    // What the gateway said, in ITS currency, for the sweep's lock fence.
    reportedAmount: d.amount,
    amount: toLedgerAmount(fx, d.amount),
    netAmount: toLedgerAmount(fx, d.netAmount),
  };
}

export function submitWithdrawal(
  input: SubmitWithdrawalInput,
  config: GatewayConfig,
): Promise<SubmitWithdrawalResult> {
  return adapterFor(config).submitWithdrawal(input, config);
}

/** As getDepositDetail: amounts converted into RM through the row's lock. */
export async function getWithdrawalDetail(
  merchantTransactionId: string,
  config: GatewayConfig,
  fx: RowFx,
): Promise<WithdrawalDetail> {
  const asked = inRowCurrency(config, fx);
  const d = await adapterFor(asked).getWithdrawalDetail(
    merchantTransactionId,
    asked,
  );
  return {
    ...d,
    amount: toLedgerAmount(fx, d.amount),
    netAmount: toLedgerAmount(fx, d.netAmount),
  };
}

export function getSupportedBanks(
  config: GatewayConfig,
): Promise<SupportedBank[]> {
  return adapterFor(config).getSupportedBanks(config);
}

export function checkBalance(config: GatewayConfig): Promise<MerchantBalance> {
  return adapterFor(config).checkBalance(config);
}

export {
  TgpayError,
  TGPAY_NOT_FOUND,
  TGPAY_PAYOUT_DISABLED,
  TGPAY_PAYOUT_FLOAT_EMPTY,
} from './tgpay-client';

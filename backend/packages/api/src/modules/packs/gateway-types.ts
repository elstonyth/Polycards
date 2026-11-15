// Gateway-neutral shapes shared by every payment-gateway client, the
// adapters in gateway.ts, and the money orchestration. They are the shapes the
// orchestration was built against (the first gateway's wire format, since
// retired), so a new gateway is an adapter that maps onto them, nothing in
// the orchestration or the sweeps.

/** What a deposit or payout has come to, in our terms. */
export type SettlementState = 'success' | 'failed' | 'pending';

/**
 * What a provider's definite answer means, named by the adapter or client
 * that read the provider's own codes. The money paths read this, never a
 * provider code:
 * - `not-sent`: refused before anything reached the provider;
 * - `payouts-off`: the provider has payouts switched off for us;
 * - `wallet-empty`: our payout wallet there is short (`available`, when the
 *   adapter confirmed it by its own balance read);
 * - `creates-nothing`: a refusal known to create no payout;
 * - `refused`: any other definite refusal;
 * - `not-found`: a lookup answer, the provider has no such payment.
 */
export type ProviderResult =
  | 'not-sent'
  | 'payouts-off'
  | 'wallet-empty'
  | 'creates-nothing'
  | 'refused'
  | 'not-found';

/**
 * Carries a gateway's error codes through for the record (`failure_reason`,
 * logs). The flag that matters for money is `definite`; what the refusal
 * means is `result`.
 */
export class GatewayError extends Error {
  readonly codes: string[];
  readonly httpStatus: number;
  /**
   * True only when the gateway PARSEABLY refused — meaning no transaction
   * exists on their side. False for timeouts, resets, WAF pages and other
   * ambiguity, where the request may have been accepted and only the
   * response was lost. Money-out callers MUST branch on this: refunding an
   * ambiguous submit would double-pay if the payout later executes.
   */
  readonly definite: boolean;
  /** Set on a definite error only ('refused' unless named), never on an
   *  ambiguous one: no result means unclear, which never moves money. */
  readonly result: ProviderResult | undefined;
  /** 'wallet-empty' confirmed by a balance read: what the wallet holds. */
  readonly available: number | undefined;

  constructor(
    message: string,
    codes: string[],
    httpStatus: number,
    definite = false,
    named: { result?: ProviderResult; available?: number } = {},
  ) {
    super(message);
    this.name = 'GatewayError';
    this.codes = codes;
    this.httpStatus = httpStatus;
    this.definite = definite;
    this.result = definite ? (named.result ?? 'refused') : undefined;
    this.available = definite ? named.available : undefined;
  }

  has(code: string): boolean {
    return this.codes.includes(code);
  }
}

export type SubmitDepositInput = {
  /** OUR reference. Must be unique per attempt. */
  merchantTransactionId: string;
  /** Our customer id, for the gateway's support/reconciliation views. */
  merchantClientId: string;
  /** MYR, 2dp. */
  amount: number;
  /** Server-to-server result callback. Must be publicly reachable. */
  notifyUrl: string;
  /** Where the customer's browser lands after the checkout. */
  returnUrl: string;
  /** The customer's IP, not ours. */
  ipAddress: string;
  /** Storefront rail code (BQR / OB / FPX / DN); each adapter maps it. */
  paymentMethodCode: string;
  /** Only some gateways need it (bank-transfer rails). */
  sourceClientBankCode?: string;
  /**
   * A regional gateway's amount, in ITS currency, from the row's FX lock
   * (payment-fx.ts). `amount` stays the RM credit; an RM gateway ignores this.
   */
  gatewayAmount?: number;
  /** Name on the PAYING bank account, for gateways that match it (A3Pay). */
  payerName?: string;
  /** The payer's name/email/phone, for gateways whose checkout needs it. */
  customer?: {
    name: string;
    email: string;
    phoneNumber: string;
  };
};

export type SubmitDepositResult = {
  transactionId: string;
  /** Checkout page. ALWAYS redirect here — it renders the gateway's own error page too. */
  url: string;
  bankCode?: string | null;
  accountNumber?: string | null;
  accountHolderName?: string | null;
  referenceNo?: string | null;
  qrCode?: string | null;
  depositActualAmount: number;
  deepLink?: string | null;
};

export type DepositDetail = {
  transactionId: string;
  merchantTransactionId: string;
  /** A gateway's own numeric status code, when it has one. */
  statusId: number | null;
  status: string;
  amount: number;
  netAmount: number;
  paymentMethodCode: string;
  bankReferenceNo?: string | null;
  uniqueReferenceNo?: string | null;
  state: SettlementState;
};

export type SubmitWithdrawalInput = {
  /** OUR reference. Must be unique per attempt. */
  merchantTransactionId: string;
  /** Our customer id, for the gateway's support/reconciliation views. */
  merchantClientId: string;
  /** MYR, 2dp. */
  amount: number;
  /** Canonical bank id (banks.ts); each adapter translates to its own code. */
  destinationBankCode: string;
  destinationAccountNumber: string;
  destinationAccountHolderName: string;
  /** Server-to-server result callback. Must be publicly reachable. */
  notifyUrl: string;
  /** Payout-verification URL, for gateways that call one before paying. */
  returnUrl: string;
  /** The customer's IP, not ours. */
  ipAddress: string;
  /** The recipient's email, for gateways whose payout needs it. */
  email?: string;
  /** A regional gateway's payout amount, in ITS currency (the row's lock). */
  gatewayAmount?: number;
};

export type SubmitWithdrawalResult = {
  /** The gateway's payout id. */
  transactionId: string;
};

export type WithdrawalDetail = {
  transactionId: string;
  merchantTransactionId: string;
  statusId: number | null;
  status: string;
  amount: number;
  netAmount: number;
  paymentMethodCode: string;
  bankReferenceNo?: string | null;
  uniqueReferenceNo?: string | null;
  state: SettlementState;
};

export type SupportedBank = {
  bankCode: string;
  bankName: string;
};

export type MerchantBalance = {
  merchantCode: string;
  currencyCode: string;
  /** Pay-in side. */
  currentBalance: number;
  /** Payout side. */
  availableBalance: number;
  t1Balance: number;
  /** Human-readable caveats (e.g. a wallet the gateway has no row for). */
  notes?: string[];
};

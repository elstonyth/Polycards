import { generateKeyPairSync } from 'node:crypto';
import { MedusaError, Modules } from '@medusajs/framework/utils';
import { setActiveGateway } from '../gateway';
import { startDeposit } from '../gateway-deposit';
import {
  RATE_CHANGED_MESSAGE,
  resetPayoutFloatBreaker,
  startWithdrawal,
  submitHeldWithdrawal,
} from '../gateway-withdrawal';
import { resetOpsAlerts } from '../ops-alert';
import { savedBankAccountId } from '../saved-accounts';

// The money guards PR #755's review added on the A3Pay (SGD) rail, each of
// which must refuse BEFORE any row or debit (or, on a held approval, before
// the claim): a quoted rate that has moved, and our own SGD float being short.

const ours = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'der' },
  privateKeyEncoding: { type: 'pkcs8', format: 'der' },
});

// mid 3.20, markup 0.10: top-ups credit RM 3.10 per S$1, payouts cost 3.30.
const FX_ROW = {
  pair: 'SGD_MYR',
  rate: 3.2,
  markup: 0.1,
  manual_override: false,
  manual_rate: null,
  fetched_at: new Date(),
};

const SG_ACCOUNT = {
  id: savedBankAccountId('DBSSSGSG', '0123456789'),
  bankCode: 'DBSSSGSG',
  bankName: 'DBS Bank',
  accountNumber: '0123456789',
  accountHolderName: 'TAN AH KOW',
  savedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
};

const ORIGINAL = { ...process.env };
const originalFetch = global.fetch;
let balanceSgd: number;
let fetchCalls: string[];

beforeEach(() => {
  process.env = {
    ...ORIGINAL,
    GATEWAY_ENABLED: 'true',
    GATEWAY_WITHDRAWALS_ENABLED: 'true',
    A3PAY_ENABLED: 'true',
    A3PAY_API_BASE: 'https://mapi.example.test',
    A3PAY_MERCHANT_CODE: 'polycards',
    A3PAY_AES_KEY: 'k',
    A3PAY_MERCHANT_PRIVATE_KEY: ours.privateKey.toString('base64'),
    A3PAY_PUBLIC_KEY: ours.publicKey.toString('base64'),
    PAYMENT_CALLBACK_BASE: 'https://us.test',
  };
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('TGPAY_')) delete process.env[k];
  }
  // The active RM gateway is TGPay, unconfigured here: its payouts are shut,
  // which is exactly when held A3Pay payouts must still be approvable.
  setActiveGateway('tgpay');
  resetPayoutFloatBreaker();
  resetOpsAlerts();
  balanceSgd = 10_000;
  fetchCalls = [];
  global.fetch = jest.fn(async (url: string) => {
    fetchCalls.push(String(url));
    if (String(url).endsWith('/api/Merchant/CheckAccBalance')) {
      return {
        status: 200,
        text: async () =>
          JSON.stringify({
            isSuccess: true,
            data: {
              mid: 'polycards',
              currCode: 'SGD',
              availableBalanceAmount: balanceSgd,
              currentBalanceAmount: balanceSgd,
              t1BalanceAmount: 0,
            },
          }),
      };
    }
    // Anything else (a submit, an ops alert) is beyond what these cases own.
    return {
      status: 500,
      text: async () => 'unexpected',
      json: async () => ({}),
    };
  }) as unknown as typeof fetch;
});

afterAll(() => {
  process.env = ORIGINAL;
  global.fetch = originalFetch;
  setActiveGateway(null);
});

function scopeFor(packs: Record<string, unknown>) {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const others: Record<string, unknown> = {
    logger,
    [Modules.CUSTOMER]: {
      retrieveCustomer: async () => ({ email: 'payee@example.test' }),
    },
    [Modules.NOTIFICATION]: { createNotifications: jest.fn() },
  };
  return { resolve: (k: string) => others[k] ?? packs } as never;
}

describe('a regional top-up at a rate the customer never saw', () => {
  it('is refused before any row when the quoted rate has moved', async () => {
    const packs = {
      listFxRates: jest.fn().mockResolvedValue([FX_ROW]),
      createDepositCapped: jest.fn(),
      updateGatewayDeposits: jest.fn(),
    };
    const error = await startDeposit(
      scopeFor(packs),
      {
        customerId: 'cus_1',
        amount: 100,
        ipAddress: '1.2.3.4',
        gateway: 'a3pay',
        paymentMethodCode: 'BQR',
        payerName: 'Tan Ah Kow',
        quotedRate: 3.15, // the sheet's rate; today's is 3.10
      },
      'https://us/notify',
      'https://us/return',
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MedusaError);
    expect((error as Error).message).toMatch(/exchange rate just changed/i);
    expect(packs.createDepositCapped).not.toHaveBeenCalled();
  });
});

describe('a regional payout', () => {
  function withdrawHarness() {
    return {
      listFxRates: jest.fn().mockResolvedValue([FX_ROW]),
      savedBankAccountsFor: jest.fn().mockResolvedValue([SG_ACCOUNT]),
      listGatewayWithdrawals: jest.fn().mockResolvedValue([]),
      createGatewayWithdrawals: jest.fn().mockResolvedValue([{ id: 'gpw_1' }]),
      updateGatewayWithdrawals: jest.fn(),
      withdrawForCashout: jest.fn(),
      withdrawCreditsWithLedger: jest.fn(),
      creditBalance: jest.fn(),
      walletSummary: jest.fn().mockResolvedValue({
        balance: 1000,
        available: 1000,
        locked: 0,
        isFrozen: false,
        hasTopup: true,
        nextUnlock: null,
        withdrawable: 1000,
        playthrough: { deposited: 0, used: 0, remaining: 0 },
      }),
    };
  }
  const start = (
    packs: ReturnType<typeof withdrawHarness>,
    over: Record<string, unknown> = {},
  ) =>
    startWithdrawal(
      scopeFor(packs),
      {
        customerId: 'cus_1',
        amount: 330, // S$100 at 3.30
        accountId: SG_ACCOUNT.id,
        ipAddress: '1.2.3.4',
        gateway: 'a3pay',
        ...over,
      },
      'https://us/notify-wd',
      'https://us/payout-verify',
    );

  it('is refused before any row or debit when the quoted rate has moved', async () => {
    const packs = withdrawHarness();
    const error = await start(packs, { quotedRate: 3.25 }).catch(
      (e: unknown) => e,
    );
    expect((error as Error).message).toBe(RATE_CHANGED_MESSAGE);
    expect(packs.createGatewayWithdrawals).not.toHaveBeenCalled();
    expect(packs.withdrawForCashout).not.toHaveBeenCalled();
  });

  it('is refused before any row or debit while OUR S$ float cannot cover it, and the next tap is turned away', async () => {
    balanceSgd = 40; // S$100 asked
    const packs = withdrawHarness();
    const error = (await start(packs, { quotedRate: 3.3 }).catch(
      (e: unknown) => e,
    )) as Error;
    expect(error.message).toMatch(/temporarily unavailable on our side/i);
    expect(error.message).toMatch(/nothing was taken/i);
    expect(packs.createGatewayWithdrawals).not.toHaveBeenCalled();
    expect(packs.withdrawForCashout).not.toHaveBeenCalled();

    // The breaker: no second balance read, no row, while ops tops it up.
    balanceSgd = 10_000;
    const reads = fetchCalls.filter((u) => u.endsWith('CheckAccBalance'));
    const again = withdrawHarness();
    await expect(start(again)).rejects.toThrow(/on our side/i);
    expect(again.createGatewayWithdrawals).not.toHaveBeenCalled();
    expect(fetchCalls.filter((u) => u.endsWith('CheckAccBalance'))).toEqual(
      reads,
    );
  });
});

describe('approving a held A3Pay payout', () => {
  const heldRow = {
    id: 'gpw_h1',
    customer_id: 'cus_1',
    merchant_transaction_id: 'PW-HELD-SG',
    amount: '3300',
    currency: 'SGD',
    gateway_amount: '1000',
    fx_mid: '3.2',
    fx_markup: '0.1',
    bank_code: 'DBSSSGSG',
    account_number: '0123456789',
    account_holder_name: 'TAN AH KOW',
    gateway: 'a3pay',
    status: 'held',
    gateway_transaction_id: null,
    gateway_status: null,
    failure_reason: null,
  };
  function approveHarness() {
    return {
      listGatewayWithdrawals: jest.fn().mockResolvedValue([heldRow]),
      listCustomerAccountStates: jest.fn().mockResolvedValue([]),
      claimWithdrawalAgainstDebit: jest
        .fn()
        .mockResolvedValue({ debited: true, claimed: true }),
      withdrawCreditsWithLedger: jest.fn(),
      updateGatewayWithdrawals: jest.fn(),
    };
  }
  const approve = (packs: ReturnType<typeof approveHarness>) =>
    submitHeldWithdrawal(scopeFor(packs), {
      withdrawalId: heldRow.id,
      adminId: 'usr_admin_1',
      payerIp: '10.0.0.7',
    });

  it('is not shut by the ACTIVE gateway having payouts off, and stays held (no claim) while our S$ float is short', async () => {
    balanceSgd = 250; // S$1,000 locked on the row
    const packs = approveHarness();
    const error = (await approve(packs).catch((e: unknown) => e)) as Error;
    // Past the old active-gateway gate: the refusal is the float, by name.
    expect(error.message).toMatch(/cannot cover this payout/i);
    expect(error.message).toMatch(/SGD 250\.00 available/);
    expect(error.message).toMatch(/stays held/i);
    expect(packs.claimWithdrawalAgainstDebit).not.toHaveBeenCalled();
    expect(packs.updateGatewayWithdrawals).not.toHaveBeenCalled();
  });
});

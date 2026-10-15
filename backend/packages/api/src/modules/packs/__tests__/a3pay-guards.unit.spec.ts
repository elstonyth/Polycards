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
import { aesDecrypt } from '../a3pay';

// The money guards PR #755's review added on the A3Pay (SGD) rail, each of
// which must refuse BEFORE any row or debit (or, on a held approval, before
// the claim): a quoted rate that has moved, and our own SGD float being short.

const ours = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'der' },
  privateKeyEncoding: { type: 'pkcs8', format: 'der' },
});

// mid 3.20, fee 3.125% each way: top-ups credit RM 3.10 per S$1, payouts
// cost 3.30.
const FX_ROW = {
  pair: 'SGD_MYR',
  rate: 3.2,
  fee_enabled: true,
  deposit_fee_percent: 3.125,
  payout_fee_percent: 3.125,
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
let submitReply: string;
let payinActual: number;

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
  submitReply = '{"isSuccess":false,"errorMessage":"unset"}';
  payinActual = 100;
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
              // Never what the pre-check reads: only AVAILABLE can pay out.
              currentBalanceAmount: 999_999,
              t1BalanceAmount: 999_999,
            },
          }),
      };
    }
    if (String(url).endsWith('/api/Payin/CreatePayin')) {
      return {
        status: 200,
        text: async () =>
          JSON.stringify({
            isSuccess: true,
            data: {
              paymentOrderId: 'D2026101200009999',
              paymentURL: 'https://cashier.a3pay.test/D2026101200009999',
              payinActualAmount: payinActual,
            },
          }),
      };
    }
    if (String(url).endsWith('/api/Payout/SubmitPayout')) {
      return { status: 400, text: async () => submitReply };
    }
    // Asked about after a refusal (refusalConfirmed): a refused submit leaves
    // nothing, so A3Pay answers its live "Not found" (a3pay-client.ts).
    if (String(url).endsWith('/api/Payout/GetPayoutDetail')) {
      return {
        status: 400,
        text: async () =>
          '{"isSuccess":false,"errorCode":null,"errorMessage":"Not found"}',
      };
    }
    // Anything else (an ops alert) is beyond what these cases own.
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

describe('a regional top-up A3Pay nudges by a cent', () => {
  function depositPacks() {
    return {
      listFxRates: jest.fn().mockResolvedValue([FX_ROW]),
      createDepositCapped: jest.fn().mockResolvedValue({ id: 'gpd_1' }),
      updateGatewayDeposits: jest.fn().mockResolvedValue(undefined),
    };
  }
  const pay = (packs: ReturnType<typeof depositPacks>, amount = 50) =>
    startDeposit(
      scopeFor(packs),
      {
        customerId: 'cus_1',
        amount,
        ipAddress: '1.2.3.4',
        gateway: 'a3pay',
        paymentMethodCode: 'BQR',
        payerName: 'Tan Ah Kow',
      },
      'https://us/notify',
      'https://us/return',
    );

  it('without a payer name it refuses before any row or gateway call', async () => {
    const packs = depositPacks();
    await expect(
      startDeposit(
        scopeFor(packs),
        {
          customerId: 'cus_1',
          amount: 50,
          ipAddress: '1.2.3.4',
          gateway: 'a3pay',
          paymentMethodCode: 'BQR',
        },
        'https://us/notify',
        'https://us/return',
      ),
    ).rejects.toThrow(/Enter the name on the bank account/);
    expect(packs.createDepositCapped).not.toHaveBeenCalled();
  });

  it('credits every cent the customer is asked for: S$50.01 at 3.10 is RM 155.03', async () => {
    payinActual = 50.01;
    const packs = depositPacks();
    const result = await pay(packs);
    // Locked first at the S$50 asked for…
    expect(packs.createDepositCapped.mock.calls[0][0].data).toMatchObject({
      amount_requested: 155,
      gateway_amount: 50,
    });
    // …then re-locked to the S$50.01 A3Pay asks them to pay, same rate.
    expect(packs.updateGatewayDeposits).toHaveBeenCalledWith({
      id: 'gpd_1',
      gateway_transaction_id: 'D2026101200009999',
      gateway_amount: 50.01,
      amount_requested: 155.03,
    });
    expect(result.amount).toBe(155.03);
  });

  // Operator decision 2026-10-14: S$ top-ups go up to A3Pay's own S$5,000,
  // which credits past the RM 10,000 that caps RM top-ups.
  it('takes S$5,000 (RM 15,500 at 3.10) and re-locks its nudge', async () => {
    payinActual = 5000.01;
    const packs = depositPacks();
    const result = await pay(packs, 5000);
    expect(packs.createDepositCapped.mock.calls[0][0].data).toMatchObject({
      amount_requested: 15500,
      gateway_amount: 5000,
    });
    expect(packs.updateGatewayDeposits).toHaveBeenCalledWith({
      id: 'gpd_1',
      gateway_transaction_id: 'D2026101200009999',
      gateway_amount: 5000.01,
      amount_requested: 15500.03,
    });
    expect(result.amount).toBe(15500.03);
  });

  it("refuses more than A3Pay's own S$5,000 before any row", async () => {
    const packs = depositPacks();
    await expect(pay(packs, 5000.01)).rejects.toThrow(
      /between SGD 30.00 and SGD 5,000.00/,
    );
    expect(packs.createDepositCapped).not.toHaveBeenCalled();
  });

  it('an un-nudged order keeps its lock', async () => {
    payinActual = 50;
    const packs = depositPacks();
    const result = await pay(packs);
    expect(packs.updateGatewayDeposits).toHaveBeenCalledWith({
      id: 'gpd_1',
      gateway_transaction_id: 'D2026101200009999',
    });
    expect(result.amount).toBe(155);
  });
});

describe('a regional payout', () => {
  function withdrawHarness() {
    return {
      listFxRates: jest.fn().mockResolvedValue([FX_ROW]),
      savedBankAccountsFor: jest.fn().mockResolvedValue([SG_ACCOUNT]),
      otherPayoutAccountHolders: jest.fn().mockResolvedValue([]),
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
        bonus: 0,
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

  // The S$ the customer is shown ("S$50.14 to your bank") must be the S$ we
  // ask A3Pay to pay and the S$ locked on the row — one figure, end to end.
  it('shows, submits and stores the same S$ amount', async () => {
    const packs = withdrawHarness();
    packs.withdrawForCashout.mockResolvedValue({
      id: 'ct_1',
      balance: 0,
      amount: -330,
      replayed: false,
      reference: null,
      destination: SG_ACCOUNT,
    });
    packs.updateGatewayWithdrawals.mockResolvedValue(undefined);
    let sent: Record<string, unknown> | null = null;
    const base = global.fetch;
    global.fetch = jest.fn(async (url: string, init?: { body?: string }) => {
      if (String(url).endsWith('/api/Payout/SubmitPayout')) {
        const envelope = JSON.parse(String(init?.body)) as { Data: string };
        sent = JSON.parse(aesDecrypt(envelope.Data, 'k'));
        return {
          status: 200,
          text: async () =>
            '{"isSuccess":true,"data":{"paymentOrderId":"W2026101400000099"}}',
        };
      }
      return (base as unknown as (u: string) => Promise<unknown>)(url);
    }) as unknown as typeof fetch;

    const result = await start(packs, { amount: 160 });
    const shown = (result as { payAmount?: number }).payAmount;
    expect(shown).toBeGreaterThan(0);
    // What A3Pay is told to pay, to the cent.
    expect(sent).not.toBeNull();
    expect(
      Number((sent as unknown as { PayoutAmount: string }).PayoutAmount),
    ).toBe(shown);
    // What the row locks (and a held approval would submit).
    expect(packs.createGatewayWithdrawals).toHaveBeenCalledWith([
      expect.objectContaining({ gateway_amount: shown, currency: 'SGD' }),
    ]);
  });

  // A retried tap (same Idempotency-Key) replays the original: it must name
  // the S$ already locked and sent, never a re-quote at today's rate.
  it("a replay echoes the row's locked S$, not today's", async () => {
    const packs = withdrawHarness();
    packs.listGatewayWithdrawals.mockResolvedValue([
      {
        merchant_transaction_id: 'PC-1',
        gateway_transaction_id: 'W2026101400000025',
        amount: 160,
        status: 'pending',
        currency: 'SGD',
        gateway_amount: 50.14,
      },
    ]);
    packs.creditBalance.mockResolvedValue(33387.4);
    const result = await start(packs, {
      amount: 160,
      idempotencyKey: 'tap-1',
    });
    expect(result).toMatchObject({
      replayed: true,
      currency: 'SGD',
      payAmount: 50.14,
    });
    expect(packs.createGatewayWithdrawals).not.toHaveBeenCalled();
  });

  it('is refused before any row or debit when the quoted rate has moved', async () => {
    const packs = withdrawHarness();
    const error = await start(packs, { quotedRate: 3.25 }).catch(
      (e: unknown) => e,
    );
    expect((error as Error).message).toBe(RATE_CHANGED_MESSAGE);
    expect(packs.createGatewayWithdrawals).not.toHaveBeenCalled();
    expect(packs.withdrawForCashout).not.toHaveBeenCalled();
  });

  it('is refused before any row or debit while OUR S$ float cannot pay anything, and the next tap is turned away', async () => {
    balanceSgd = 20; // under the S$30 payout minimum; S$100 asked
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

describe('the payout-float breaker cannot be tripped by one customer', () => {
  function packsFor() {
    return {
      listFxRates: jest.fn().mockResolvedValue([FX_ROW]),
      savedBankAccountsFor: jest.fn().mockResolvedValue([SG_ACCOUNT]),
      otherPayoutAccountHolders: jest.fn().mockResolvedValue([]),
      listGatewayWithdrawals: jest.fn().mockResolvedValue([]),
      createGatewayWithdrawals: jest.fn().mockResolvedValue([{ id: 'gpw_1' }]),
      updateGatewayWithdrawals: jest.fn().mockResolvedValue(undefined),
      withdrawForCashout: jest.fn().mockResolvedValue({
        id: 'ct_1',
        balance: 0,
        amount: -330,
        replayed: false,
        reference: null,
        destination: SG_ACCOUNT,
      }),
      withdrawCreditsWithLedger: jest.fn().mockResolvedValue({
        id: 'ct_2',
        balance: 330,
        amount: 330,
        replayed: false,
        reference: null,
      }),
      creditBalance: jest.fn(),
      walletSummary: jest.fn().mockResolvedValue({
        balance: 50_000,
        available: 50_000,
        locked: 0,
        isFrozen: false,
        hasTopup: true,
        nextUnlock: null,
        withdrawable: 50_000,
        bonus: 0,
        playthrough: { deposited: 0, used: 0, remaining: 0 },
      }),
    };
  }
  const go = (packs: ReturnType<typeof packsFor>, amount: number) =>
    startWithdrawal(
      scopeFor(packs),
      {
        customerId: 'cus_1',
        amount,
        accountId: SG_ACCOUNT.id,
        ipAddress: '1.2.3.4',
        gateway: 'a3pay',
      },
      'https://us/notify-wd',
      'https://us/payout-verify',
    );

  it('a request larger than the float is refused alone; a smaller one still goes through', async () => {
    balanceSgd = 80; // can pay S$30-80, not S$100
    const big = packsFor();
    await expect(go(big, 330)).rejects.toThrow(/on our side/i);
    expect(big.createGatewayWithdrawals).not.toHaveBeenCalled();

    const small = packsFor();
    await go(small, 198).catch(() => undefined); // S$60
    expect(small.createGatewayWithdrawals).toHaveBeenCalled();
  });

  it("counts A3Pay's own payout fee: S$100 needs S$101.50 in the float", async () => {
    // The wallet pays the amount PLUS A3Pay's 1.5%, so S$100.50 cannot.
    balanceSgd = 100.5;
    const short = packsFor();
    await expect(go(short, 330)).rejects.toThrow(/on our side/i);
    expect(short.createGatewayWithdrawals).not.toHaveBeenCalled();

    balanceSgd = 101.5;
    const enough = packsFor();
    await go(enough, 330).catch(() => undefined);
    expect(enough.createGatewayWithdrawals).toHaveBeenCalled();
  });

  it('a refusal merely MENTIONING funds does not trip it while the balance read says the float is fine', async () => {
    submitReply = JSON.stringify({
      isSuccess: false,
      errorMessage: 'Insufficient beneficiary details',
    });
    const first = packsFor();
    const error = (await go(first, 330).catch((e: unknown) => e)) as Error;
    expect(error.message).not.toMatch(/on our side/i);
    // Refunded as an ordinary definite refusal.
    expect(first.withdrawCreditsWithLedger).toHaveBeenCalledTimes(1);

    const next = packsFor();
    await go(next, 330).catch(() => undefined);
    expect(next.createGatewayWithdrawals).toHaveBeenCalled();
  });

  /** Balance reads answer `first`, then `afterwards` for every later read.
   *  Always wraps the test's ORIGINAL fetch mock, never a previous wrapper. */
  const originals = new WeakMap<jest.Mock, unknown>();
  function balanceReads(first: number, afterwards: number) {
    let reads = 0;
    const mocked = global.fetch as unknown as jest.Mock;
    if (!originals.has(mocked))
      originals.set(mocked, mocked.getMockImplementation());
    const inner = originals.get(mocked) as (
      url: string,
      init: unknown,
    ) => Promise<unknown>;
    mocked.mockImplementation(async (url: string, init: unknown) => {
      if (String(url).endsWith('CheckAccBalance')) {
        balanceSgd = reads++ === 0 ? first : afterwards;
      }
      return inner(url, init);
    });
  }

  it('the same refusal with the float really empty trips it for everyone', async () => {
    submitReply = JSON.stringify({
      isSuccess: false,
      errorMessage: 'Insufficient balance',
    });
    // Enough at the pre-check, under the S$30 minimum by the confirming
    // re-read (another payout drained it in between).
    balanceReads(10_000, 10);
    const first = packsFor();
    await expect(go(first, 330)).rejects.toThrow(/on our side/i);

    // Refilled: the pre-check would pass, so only the breaker refuses.
    balanceReads(10_000, 10_000);
    const next = packsFor();
    await expect(go(next, 330)).rejects.toThrow(/on our side/i);
    expect(next.createGatewayWithdrawals).not.toHaveBeenCalled();
  });

  it('short for THIS amount only: refused on our side, the gateway stays open', async () => {
    submitReply = JSON.stringify({
      isSuccess: false,
      errorMessage: 'Insufficient balance',
    });
    balanceReads(10_000, 80); // S$100 asked; S$30-80 still payable
    const first = packsFor();
    await expect(go(first, 330)).rejects.toThrow(/on our side/i);

    balanceReads(10_000, 10_000);
    const next = packsFor();
    await go(next, 330).catch(() => undefined);
    expect(next.createGatewayWithdrawals).toHaveBeenCalled();
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

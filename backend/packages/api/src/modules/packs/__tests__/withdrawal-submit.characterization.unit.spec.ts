// Characterization of the payout submit, written BEFORE Withdrawal Submit was
// extracted (architecture candidate 5). It drives both callers — a new
// Withdrawal (startWithdrawal) and an admin-approved Held Withdrawal
// (submitHeldWithdrawal) — through the fake gateway for every provider
// outcome, and pins what each one does: the refund on the ledger, the row
// writes, the words, the ops alerts, the receipt and feed row, the breaker.
//
// Frozen: only the three owner decisions may change it (Q4 pre-send refusals
// refund at once, Q5 both paths refund through refundWithdrawal, Q7 approve
// keeps the row held while the wallet breaker is tripped). Each such line is
// marked with its decision.
//
// Outcomes are scripted by name (fakeGateway.refuse), never by a provider
// code, so the spec reads the same before and after the named results.
//
// Known limit: A3Pay's balance-confirmed "wallet empty" is driven on the held
// path only. The fake is an RM gateway, so a new Withdrawal through it carries
// no payout-currency amount, and the confirmation needs one. The A3Pay
// adapter's own spec pins the confirmation itself.

jest.mock('../ops-alert', () => {
  const actual = jest.requireActual('../ops-alert');
  return {
    ...actual,
    alertOps: jest.fn(async () => undefined),
    alertPayoutDisabled: jest.fn(async () => undefined),
    alertPayoutFloatEmpty: jest.fn(async () => undefined),
  };
});

import { Modules } from '@medusajs/framework/utils';
import {
  resetPayoutFloatBreaker,
  startWithdrawal,
  submitHeldWithdrawal,
  withdrawalRefundReference,
} from '../gateway-withdrawal';
import { GATEWAYS, GatewayError, setActiveGateway } from '../gateway';
import { fakeGateway } from '../fake-gateway';
import { savedBankAccountId } from '../saved-accounts';
import { DEFAULT_WITHDRAWAL_CONTROLS } from '../withdrawal-controls';
import {
  alertOps,
  alertPayoutDisabled,
  alertPayoutFloatEmpty,
} from '../ops-alert';

const LABEL = GATEWAYS.fake.label;

const SAVED = {
  id: savedBankAccountId('MBBEMYKL', '123456789012'),
  bankCode: 'MBBEMYKL',
  bankName: 'Maybank',
  accountNumber: '123456789012',
  accountHolderName: 'AHMAD BIN ALI',
  savedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
};

const TNG = {
  ...SAVED,
  id: savedBankAccountId('TNGMY', '123456789012'),
  bankCode: 'TNGMY',
  bankName: "Touch 'n Go eWallet",
};

const standing = () => ({
  bankId: 'MBBEMYKL',
  key: SAVED.accountNumber,
  forms: [SAVED.accountNumber],
  banned: false,
  bannedForPlayer: false,
  holders: [],
});

/** What a notification spy saw, by channel ('email' = receipt). */
const channels = (notify: jest.Mock) =>
  notify.mock.calls.map(([n]: [{ channel: string }]) => n.channel);

function others(email: string) {
  const notify = jest.fn(async () => undefined);
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return {
    notify,
    logger,
    map: {
      logger,
      [Modules.NOTIFICATION]: { createNotifications: notify },
      [Modules.CUSTOMER]: { retrieveCustomer: async () => ({ email }) },
    } as Record<string, unknown>,
  };
}

// ---------------------------------------------------------------------------
// A new Withdrawal (startWithdrawal), below the approval threshold.

function newPath(account = SAVED) {
  const packs = {
    savedBankAccountsFor: jest.fn().mockResolvedValue([account]),
    payoutNumberStanding: jest.fn().mockResolvedValue(standing()),
    bankShareVerifiedFor: jest.fn().mockResolvedValue({}),
    createGatewayWithdrawals: jest.fn().mockResolvedValue([{ id: 'gpw_1' }]),
    listGatewayWithdrawals: jest.fn().mockResolvedValue([]),
    creditBalance: jest.fn().mockResolvedValue(50),
    updateGatewayWithdrawals: jest.fn().mockResolvedValue(undefined),
    listCreditTransactions: jest.fn().mockResolvedValue([]),
    // The destination locked at debit. Its holder name differs from the saved
    // copy on purpose: the gateway must be told the locked one.
    withdrawForCashout: jest.fn().mockResolvedValue({
      id: 'ct_1',
      balance: 950,
      amount: -100,
      replayed: false,
      reference: null,
      destination: { ...account, accountHolderName: ' AHMAD B. ALI ' },
    }),
    withdrawCreditsWithLedger: jest.fn().mockResolvedValue({
      id: 'ct_2',
      balance: 1050,
      amount: 100,
      replayed: false,
      reference: null,
    }),
    walletSummary: jest.fn().mockResolvedValue({
      balance: 1050,
      available: 1050,
      locked: 0,
      isFrozen: false,
      hasTopup: true,
      nextUnlock: null,
      withdrawable: 1050,
      bonus: 0,
      playthrough: { deposited: 0, used: 0, remaining: 0 },
    }),
    withdrawalControls: jest
      .fn()
      .mockResolvedValue(DEFAULT_WITHDRAWAL_CONTROLS),
  };
  const o = others('cus1@x.test');
  const scope = {
    resolve: (k: string) => o.map[k] ?? packs,
  } as never;
  const start = () =>
    startWithdrawal(
      scope,
      {
        customerId: 'cus_1',
        amount: 100,
        accountId: account.id,
        ipAddress: '1.2.3.4',
        email: 'cus1@x.test',
      },
      'https://us/notify-wd',
      'https://us/payout-verify',
    );
  /** Our reference, as the row was written with it. */
  const ref = (): string =>
    packs.createGatewayWithdrawals.mock.calls[0][0][0].merchant_transaction_id;
  return { packs, ...o, scope, start, ref };
}

/** The refund the new path writes: the locked destination, our reference. */
const newRefund = (ref: string, bankCode = 'MBBEMYKL') => ({
  customerId: 'cus_1',
  amount: 100,
  reason: 'cashout',
  reference: ref,
  idempotencyReference: withdrawalRefundReference('cus_1', ref),
  ledger: {
    outcome: 'refunded',
    bankCode,
    accountNumber: '123456789012',
    gatewayRef: ref,
  },
});

/** The new path's close after a refund. */
const newClose = (reason: RegExp) =>
  // Q5 will change this: an unscoped close by id, today.
  ({
    id: 'gpw_1',
    status: 'failed',
    failure_reason: expect.stringMatching(reason),
  });

const CUSTOMER = {
  ourSide:
    'Withdrawals are temporarily unavailable on our side and your balance has been returned. Your bank details are fine — there is no need to change them. Please try again later.',
  partner:
    'Withdrawals are temporarily unavailable from our payout partner. Your balance has been returned and your bank details are fine. Please try again later.',
  tng: "Touch 'n Go withdrawals are temporarily unavailable from our payment provider. Your balance has been returned. Please withdraw to a bank account for now.",
  refused:
    'Your withdrawal was refused by the payment provider and your balance has been returned. Check your bank details are correct — if they are, contact support rather than retrying.',
  breaker:
    'Withdrawals are temporarily unavailable on our side — nothing was taken from your balance. Please try again in a few minutes.',
};

// ---------------------------------------------------------------------------
// An admin-approved Held Withdrawal (submitHeldWithdrawal).

const HELD_ROW = {
  id: 'gpw_h1',
  customer_id: 'cus_1',
  merchant_transaction_id: 'PW-HELD-1',
  amount: '1500',
  bank_code: 'MBBEMYKL',
  account_number: SAVED.accountNumber,
  account_holder_name: 'AHMAD BIN ALI ',
  gateway: 'fake',
  status: 'held',
  gateway_transaction_id: null,
  gateway_status: null,
  failure_reason: null,
};

function heldPath(row: Record<string, unknown> = HELD_ROW) {
  const packs = {
    listGatewayWithdrawals: jest.fn().mockResolvedValue([row]),
    listCustomerAccountStates: jest.fn().mockResolvedValue([]),
    payoutNumberStanding: jest.fn().mockResolvedValue(standing()),
    bankShareVerifiedFor: jest.fn().mockResolvedValue({}),
    claimWithdrawalAgainstDebit: jest
      .fn()
      .mockResolvedValue({ debited: true, claimed: true }),
    withdrawCreditsWithLedger: jest.fn().mockResolvedValue({
      id: 'ct_2',
      balance: 1500,
      amount: 1500,
      replayed: false,
      reference: null,
    }),
    updateGatewayWithdrawals: jest.fn().mockResolvedValue(undefined),
  };
  const o = others('payee@example.test');
  const scope = {
    resolve: (k: string) => o.map[k] ?? packs,
  } as never;
  const approve = () =>
    submitHeldWithdrawal(scope, {
      withdrawalId: 'gpw_h1',
      adminId: 'usr_admin_1',
      payerIp: '10.0.0.7',
    });
  return { packs, ...o, scope, approve };
}

const heldRefund = {
  customerId: 'cus_1',
  amount: 1500,
  reason: 'cashout',
  reference: 'PW-HELD-1',
  idempotencyReference: withdrawalRefundReference('cus_1', 'PW-HELD-1'),
  ledger: {
    outcome: 'refunded',
    bankCode: 'MBBEMYKL',
    accountNumber: '123456789012',
    gatewayRef: 'PW-HELD-1',
  },
};

const heldClose = (reason: RegExp) => ({
  selector: { id: 'gpw_h1', status: 'pending' },
  data: {
    status: 'failed',
    gateway_status: null,
    failure_reason: expect.stringMatching(reason),
  },
});

const ADMIN = {
  refused:
    'The gateway refused this payout. The debit has been refunded and the withdrawal closed.',
  payoutsOff: `${LABEL} refused this payout because payouts are not enabled on our ${LABEL} account ("Payout not available"). The debit has been refunded and the withdrawal closed. Ask ${LABEL} to enable payouts, or switch back to a gateway that pays out, then ask the customer to request the withdrawal again.`,
  walletEmpty: `${LABEL} refused this payout because our ${LABEL} payout wallet is short ("Insufficient payout credit balance"). The debit has been refunded and the withdrawal closed. Top up the payout wallet, then ask the customer to request the withdrawal again.`,
};

/** The lookup answers judgeRefusal can get after a definite refusal. */
const detail = (state: 'pending' | 'failed') => ({
  transactionId: 'T-HOLD',
  merchantTransactionId: 'x',
  statusId: null,
  status: state === 'pending' ? 'PENDING' : 'REJECTED',
  amount: 100,
  netAmount: Number.NaN,
  paymentMethodCode: 'WD',
  bankReferenceNo: null,
  uniqueReferenceNo: null,
  state,
});
const LOOKUP_DOWN = () => new GatewayError('non-JSON response', [], 502);

/** Is the gateway closed to the next customer (the 5-minute breaker)? */
async function breakerTripped(): Promise<boolean> {
  const h = newPath();
  const error = await h.start().catch((e: unknown) => e);
  return (
    error instanceof Error &&
    error.message === CUSTOMER.breaker &&
    h.packs.createGatewayWithdrawals.mock.calls.length === 0
  );
}

const ORIGINAL = { ...process.env };

beforeEach(() => {
  jest.clearAllMocks();
  fakeGateway.reset();
  resetPayoutFloatBreaker();
  setActiveGateway('fake');
  process.env.GATEWAY_ENABLED = 'true';
  process.env.GATEWAY_WITHDRAWALS_ENABLED = 'true';
  process.env.PAYMENT_GATEWAY = 'fake';
  process.env.PAYMENT_CALLBACK_BASE = 'https://us.test';
  process.env.TNG_PAYOUTS_ENABLED = 'true';
});

afterAll(() => {
  process.env = ORIGINAL;
  setActiveGateway(null);
});

describe('a new Withdrawal', () => {
  it('success: submits the locked destination and stamps their id on the pending row', async () => {
    const h = newPath();
    fakeGateway.script({ submitWithdrawal: { transactionId: 'W-OK-1' } });
    expect(await h.start()).toEqual({
      merchantTransactionId: h.ref(),
      transactionId: 'W-OK-1',
      amount: 100,
      balance: 950,
      status: 'pending',
    });
    expect(fakeGateway.calls.withdrawals).toEqual([
      {
        merchantTransactionId: h.ref(),
        merchantClientId: 'cus_1',
        amount: 100,
        destinationBankCode: 'MBBEMYKL',
        destinationAccountNumber: '123456789012',
        destinationAccountHolderName: 'AHMAD B. ALI',
        notifyUrl: 'https://us/notify-wd',
        returnUrl: 'https://us/payout-verify',
        ipAddress: '1.2.3.4',
        email: 'cus1@x.test',
      },
    ]);
    expect(h.packs.updateGatewayWithdrawals.mock.calls).toEqual([
      [
        {
          selector: { id: 'gpw_1', status: 'pending' },
          data: { gateway_transaction_id: 'W-OK-1' },
        },
      ],
    ]);
    expect(h.packs.withdrawCreditsWithLedger).not.toHaveBeenCalled();
    expect(channels(h.notify)).toEqual([]);
    expect(fakeGateway.calls.withdrawalDetails).toEqual([]);
  });

  it('payouts off: refunds without asking, our-side words, alert, breaker', async () => {
    const h = newPath();
    fakeGateway.refuse('payouts-off', { codes: ['X1'] });
    await expect(h.start()).rejects.toThrow(CUSTOMER.ourSide);
    expect(fakeGateway.calls.withdrawalDetails).toEqual([]);
    expect(h.packs.withdrawCreditsWithLedger.mock.calls).toEqual([
      [newRefund(h.ref())],
    ]);
    expect(h.packs.updateGatewayWithdrawals.mock.calls).toEqual([
      [
        newClose(
          /^submit refused: codes=X1\S* httpStatus=501 bankCode=MBBEMYKL msg=fake payout failed \(HTTP 501\): Payout not available$/,
        ),
      ],
    ]);
    // The customer is on screen: no receipt, no feed row.
    expect(channels(h.notify)).toEqual([]);
    expect(h.logger.warn.mock.calls).toEqual([
      [
        expect.stringMatching(
          new RegExp(
            `^\\[payments\\] withdrawal refused: codes=X1\\S* httpStatus=501 definite=true bankCode=MBBEMYKL amount=100 ref=${h.ref()} msg=fake payout failed`,
          ),
        ),
      ],
    ]);
    expect(jest.mocked(alertPayoutDisabled).mock.calls).toEqual([
      [
        h.scope,
        {
          amount: 100,
          ref: h.ref(),
          via: 'customer withdrawal',
          gateway: LABEL,
        },
      ],
    ]);
    expect(alertPayoutFloatEmpty).not.toHaveBeenCalled();
    expect(await breakerTripped()).toBe(true);
  });

  describe('TGPay wallet empty', () => {
    it('lookup not found: refunds, our-side words, alert (refunded), breaker', async () => {
      const h = newPath();
      fakeGateway.refuse('wallet-empty', { codes: ['X1'] });
      await expect(h.start()).rejects.toThrow(CUSTOMER.ourSide);
      expect(fakeGateway.calls.withdrawalDetails).toEqual([h.ref()]);
      expect(h.packs.withdrawCreditsWithLedger.mock.calls).toEqual([
        [newRefund(h.ref())],
      ]);
      expect(h.packs.updateGatewayWithdrawals.mock.calls).toEqual([
        [
          newClose(
            /^submit refused: codes=X1\S* httpStatus=400 bankCode=MBBEMYKL msg=fake payout failed: Insufficient payout credit balance$/,
          ),
        ],
      ]);
      expect(channels(h.notify)).toEqual([]);
      expect(jest.mocked(alertPayoutFloatEmpty).mock.calls).toEqual([
        [
          h.scope,
          {
            amount: 100,
            ref: h.ref(),
            via: 'customer withdrawal',
            gateway: LABEL,
            refunded: true,
          },
        ],
      ]);
      expect(await breakerTripped()).toBe(true);
    });

    it('lookup unreachable: waits with nothing written, alert (left pending), breaker', async () => {
      const h = newPath();
      fakeGateway.refuse('wallet-empty', { codes: ['X1'] });
      fakeGateway.script({ getWithdrawalDetail: LOOKUP_DOWN() });
      expect(await h.start()).toEqual({
        merchantTransactionId: h.ref(),
        transactionId: null,
        amount: 100,
        balance: 950,
        status: 'pending',
      });
      expect(h.packs.withdrawCreditsWithLedger).not.toHaveBeenCalled();
      expect(h.packs.updateGatewayWithdrawals).not.toHaveBeenCalled();
      expect(h.logger.error.mock.calls).toEqual([
        [
          `[payments] withdrawal ${h.ref()} submit outcome AMBIGUOUS (refusal not confirmed: the gateway holds this payout or could not be asked — fake payout failed: Insufficient payout credit balance) — left pending for the sweep`,
        ],
      ]);
      expect(jest.mocked(alertPayoutFloatEmpty).mock.calls).toEqual([
        [
          h.scope,
          {
            amount: 100,
            ref: h.ref(),
            via: 'customer withdrawal',
            gateway: LABEL,
            refunded: false,
          },
        ],
      ]);
      expect(await breakerTripped()).toBe(true);
    });
  });

  it('"no payout provider" (creates nothing), bank: refunds, partner words, no alert, no breaker', async () => {
    const h = newPath();
    fakeGateway.refuse('creates-nothing', { codes: ['X1'] });
    await expect(h.start()).rejects.toThrow(CUSTOMER.partner);
    expect(h.packs.withdrawCreditsWithLedger.mock.calls).toEqual([
      [newRefund(h.ref())],
    ]);
    expect(h.packs.updateGatewayWithdrawals.mock.calls).toEqual([
      [
        newClose(
          /^submit refused: codes=X1\S* httpStatus=400 bankCode=MBBEMYKL msg=.*No payout provider is available/,
        ),
      ],
    ]);
    expect(channels(h.notify)).toEqual([]);
    expect(alertPayoutFloatEmpty).not.toHaveBeenCalled();
    expect(alertPayoutDisabled).not.toHaveBeenCalled();
    expect(alertOps).not.toHaveBeenCalled();
    expect(await breakerTripped()).toBe(false);
  });

  it('"no payout provider" (creates nothing), Touch \'n Go: refunds, sends them to a bank', async () => {
    const h = newPath(TNG);
    fakeGateway.refuse('creates-nothing', { codes: ['X1'] });
    await expect(h.start()).rejects.toThrow(CUSTOMER.tng);
    expect(h.packs.withdrawCreditsWithLedger.mock.calls).toEqual([
      [newRefund(h.ref(), 'TNGMY')],
    ]);
    expect(channels(h.notify)).toEqual([]);
  });

  describe('any other definite refusal', () => {
    it('the gateway holds it: waits, with their id and the refusal on the pending row', async () => {
      const h = newPath();
      fakeGateway.refuse('refused', { codes: ['X1'] });
      fakeGateway.script({ getWithdrawalDetail: detail('pending') });
      await expect(h.start()).resolves.toMatchObject({
        status: 'pending',
        transactionId: null,
      });
      expect(h.packs.withdrawCreditsWithLedger).not.toHaveBeenCalled();
      expect(h.packs.updateGatewayWithdrawals.mock.calls).toEqual([
        [
          {
            selector: { id: 'gpw_1', status: 'pending' },
            data: {
              gateway_transaction_id: 'T-HOLD',
              failure_reason: expect.stringMatching(
                /^submit refused, but the gateway holds it: codes=X1\S* httpStatus=400 bankCode=MBBEMYKL msg=fake payout failed: refused$/,
              ),
            },
          },
        ],
      ]);
      expect(h.logger.error).toHaveBeenCalledWith(
        expect.stringContaining('submit outcome AMBIGUOUS (refusal not confirmed'),
      );
      expect(alertPayoutFloatEmpty).not.toHaveBeenCalled();
      expect(await breakerTripped()).toBe(false);
    });

    it('the lookup answers failed: refunds, generic words', async () => {
      const h = newPath();
      fakeGateway.refuse('refused', { codes: ['X1'] });
      fakeGateway.script({ getWithdrawalDetail: detail('failed') });
      await expect(h.start()).rejects.toThrow(CUSTOMER.refused);
      expect(h.packs.withdrawCreditsWithLedger.mock.calls).toEqual([
        [newRefund(h.ref())],
      ]);
      expect(h.packs.updateGatewayWithdrawals.mock.calls).toEqual([
        [
          newClose(
            /^submit refused: codes=X1\S* httpStatus=400 bankCode=MBBEMYKL msg=fake payout failed: refused$/,
          ),
        ],
      ]);
      expect(channels(h.notify)).toEqual([]);
      expect(alertPayoutFloatEmpty).not.toHaveBeenCalled();
      expect(alertPayoutDisabled).not.toHaveBeenCalled();
    });

    it('the lookup fails: waits, nothing written to the row', async () => {
      const h = newPath();
      fakeGateway.refuse('refused', { codes: ['X1'] });
      fakeGateway.script({ getWithdrawalDetail: LOOKUP_DOWN() });
      await expect(h.start()).resolves.toMatchObject({ status: 'pending' });
      expect(h.packs.withdrawCreditsWithLedger).not.toHaveBeenCalled();
      expect(h.packs.updateGatewayWithdrawals).not.toHaveBeenCalled();
    });

    it('not found, unproven: waits, the "not confirmed" refusal on the row', async () => {
      const h = newPath();
      fakeGateway.refuse('refused', { codes: ['X1'] });
      await expect(h.start()).resolves.toMatchObject({
        status: 'pending',
        transactionId: null,
      });
      expect(fakeGateway.calls.withdrawalDetails).toEqual([h.ref()]);
      expect(h.packs.withdrawCreditsWithLedger).not.toHaveBeenCalled();
      expect(h.packs.updateGatewayWithdrawals.mock.calls).toEqual([
        [
          {
            selector: { id: 'gpw_1', status: 'pending' },
            data: {
              failure_reason: expect.stringMatching(
                /^submit refused, not confirmed: left for the sweep: codes=X1\S* httpStatus=400 bankCode=MBBEMYKL msg=fake payout failed: refused$/,
              ),
            },
          },
        ],
      ]);
      expect(channels(h.notify)).toEqual([]);
      expect(alertPayoutFloatEmpty).not.toHaveBeenCalled();
    });
  });

  it('refused before sending', async () => {
    const h = newPath();
    fakeGateway.refuse('not-sent', { codes: ['X1'] });
    // Q4 will change this: asked, "not found" read as unproven, left pending.
    await expect(h.start()).resolves.toMatchObject({ status: 'pending' });
    expect(fakeGateway.calls.withdrawalDetails).toEqual([h.ref()]);
    expect(h.packs.withdrawCreditsWithLedger).not.toHaveBeenCalled();
    expect(h.packs.updateGatewayWithdrawals.mock.calls).toEqual([
      [
        {
          selector: { id: 'gpw_1', status: 'pending' },
          data: {
            failure_reason: expect.stringMatching(
              /^submit refused, not confirmed: left for the sweep: codes=X1\S* httpStatus=400 bankCode=MBBEMYKL msg=Fake: cannot pay to bank/,
            ),
          },
        },
      ],
    ]);
    expect(channels(h.notify)).toEqual([]);
    expect(alertPayoutFloatEmpty).not.toHaveBeenCalled();
  });

  it.each([
    ['a lost response', () => new Error('socket hang up'), 'socket hang up'],
    [
      'a non-definite gateway answer',
      () => new GatewayError('non-JSON response', [], 503),
      'non-JSON response',
    ],
  ])(
    'ambiguous (%s): waits, nothing written, no alert',
    async (_label, error, why) => {
      const h = newPath();
      fakeGateway.script({ submitWithdrawal: error() });
      expect(await h.start()).toEqual({
        merchantTransactionId: h.ref(),
        transactionId: null,
        amount: 100,
        balance: 950,
        status: 'pending',
      });
      expect(fakeGateway.calls.withdrawalDetails).toEqual([]);
      expect(h.packs.withdrawCreditsWithLedger).not.toHaveBeenCalled();
      expect(h.packs.updateGatewayWithdrawals).not.toHaveBeenCalled();
      expect(h.logger.error.mock.calls).toEqual([
        [
          `[payments] withdrawal ${h.ref()} submit outcome AMBIGUOUS (${why}) — left pending for the sweep`,
        ],
      ]);
      expect(alertPayoutFloatEmpty).not.toHaveBeenCalled();
      expect(alertPayoutDisabled).not.toHaveBeenCalled();
      expect(await breakerTripped()).toBe(false);
    },
  );
});

describe('an admin-approved Held Withdrawal', () => {
  it('success: submits the row’s destination and stamps their id', async () => {
    const h = heldPath();
    fakeGateway.script({ submitWithdrawal: { transactionId: 'W-OK-1' } });
    await expect(h.approve()).resolves.toEqual({
      id: 'gpw_h1',
      status: 'pending',
      transaction_id: 'W-OK-1',
      approved: true,
    });
    expect(fakeGateway.calls.withdrawals).toEqual([
      {
        email: 'payee@example.test',
        merchantTransactionId: 'PW-HELD-1',
        merchantClientId: 'cus_1',
        amount: 1500,
        destinationBankCode: 'MBBEMYKL',
        destinationAccountNumber: '123456789012',
        destinationAccountHolderName: 'AHMAD BIN ALI',
        notifyUrl: 'https://us.test/hooks/fake/withdrawal',
        returnUrl: expect.any(String),
        ipAddress: '10.0.0.7',
      },
    ]);
    expect(h.packs.updateGatewayWithdrawals.mock.calls).toEqual([
      [
        {
          selector: { id: 'gpw_h1', status: 'pending' },
          data: { gateway_transaction_id: 'W-OK-1' },
        },
      ],
    ]);
    expect(h.packs.withdrawCreditsWithLedger).not.toHaveBeenCalled();
    expect(h.logger.info).toHaveBeenCalledWith(
      '[payments] admin usr_admin_1 APPROVED withdrawal gpw_h1 (PW-HELD-1) — RM 1500 to bank MBBEMYKL',
    );
  });

  it('payouts off: refunds without asking, payouts-off words, receipt and feed, alert, breaker', async () => {
    const h = heldPath();
    fakeGateway.refuse('payouts-off', { codes: ['X1'] });
    await expect(h.approve()).rejects.toThrow(ADMIN.payoutsOff);
    expect(fakeGateway.calls.withdrawalDetails).toEqual([]);
    expect(h.packs.withdrawCreditsWithLedger.mock.calls).toEqual([
      [heldRefund],
    ]);
    expect(h.packs.updateGatewayWithdrawals.mock.calls).toEqual([
      [
        heldClose(
          /^approve refused: codes=X1\S* httpStatus=501 bankCode=MBBEMYKL msg=fake payout failed \(HTTP 501\): Payout not available$/,
        ),
      ],
    ]);
    expect(channels(h.notify)).toEqual(['email', 'customer_feed']);
    expect(h.logger.warn.mock.calls).toEqual([
      [
        expect.stringMatching(
          /^\[payments\] admin-approved withdrawal refused: codes=X1\S* httpStatus=501 definite=true bankCode=MBBEMYKL amount=1500 ref=PW-HELD-1 msg=fake payout failed/,
        ),
      ],
    ]);
    expect(jest.mocked(alertPayoutDisabled).mock.calls).toEqual([
      [
        h.scope,
        {
          amount: 1500,
          ref: 'PW-HELD-1',
          via: 'admin approve',
          gateway: LABEL,
        },
      ],
    ]);
    expect(await breakerTripped()).toBe(true);
  });

  describe('TGPay wallet empty', () => {
    it('lookup not found: refunds, wallet words, alert (refunded), breaker', async () => {
      const h = heldPath();
      fakeGateway.refuse('wallet-empty', { codes: ['X1'] });
      await expect(h.approve()).rejects.toThrow(ADMIN.walletEmpty);
      expect(h.packs.withdrawCreditsWithLedger.mock.calls).toEqual([
        [heldRefund],
      ]);
      expect(h.packs.updateGatewayWithdrawals.mock.calls).toEqual([
        [
          heldClose(
            /^approve refused: codes=X1\S* httpStatus=400 bankCode=MBBEMYKL msg=fake payout failed: Insufficient payout credit balance$/,
          ),
        ],
      ]);
      expect(channels(h.notify)).toEqual(['email', 'customer_feed']);
      expect(jest.mocked(alertPayoutFloatEmpty).mock.calls).toEqual([
        [
          h.scope,
          {
            amount: 1500,
            ref: 'PW-HELD-1',
            via: 'admin approve',
            gateway: LABEL,
            refunded: true,
          },
        ],
      ]);
      expect(await breakerTripped()).toBe(true);
    });

    it('lookup unreachable: waits, alert (left pending), breaker', async () => {
      const h = heldPath();
      fakeGateway.refuse('wallet-empty', { codes: ['X1'] });
      fakeGateway.script({ getWithdrawalDetail: LOOKUP_DOWN() });
      await expect(h.approve()).resolves.toEqual({
        id: 'gpw_h1',
        status: 'pending',
        transaction_id: null,
        approved: true,
      });
      expect(h.packs.withdrawCreditsWithLedger).not.toHaveBeenCalled();
      expect(h.packs.updateGatewayWithdrawals).not.toHaveBeenCalled();
      expect(h.logger.error.mock.calls).toEqual([
        [
          '[payments] admin usr_admin_1 approved withdrawal PW-HELD-1 but the submit outcome is AMBIGUOUS (refusal not confirmed: the gateway holds this payout or could not be asked — fake payout failed: Insufficient payout credit balance) — left pending for the sweep',
        ],
      ]);
      expect(jest.mocked(alertPayoutFloatEmpty).mock.calls).toEqual([
        [
          h.scope,
          {
            amount: 1500,
            ref: 'PW-HELD-1',
            via: 'admin approve',
            gateway: LABEL,
            refunded: false,
          },
        ],
      ]);
      expect(await breakerTripped()).toBe(true);
    });
  });

  describe('A3Pay wallet empty (a balance hint, confirmed by a balance read)', () => {
    // A payout-currency row: the confirmation compares the balance to it.
    const regional = { ...HELD_ROW, currency: 'SGD', gateway_amount: '450' };

    it('confirmed: refunds, wallet words, alert (refunded); a float above nothing does not close the gateway', async () => {
      const h = heldPath(regional);
      fakeGateway.refuse('wallet-empty', { codes: ['X1'], available: 100 });
      await expect(h.approve()).rejects.toThrow(ADMIN.walletEmpty);
      expect(fakeGateway.calls.withdrawals[0]).toMatchObject({
        gatewayAmount: 450,
      });
      expect(h.packs.withdrawCreditsWithLedger.mock.calls).toEqual([
        [heldRefund],
      ]);
      expect(h.packs.updateGatewayWithdrawals.mock.calls).toEqual([
        [heldClose(/^approve refused: codes=X1\S* httpStatus=400 /)],
      ]);
      expect(jest.mocked(alertPayoutFloatEmpty).mock.calls).toEqual([
        [
          h.scope,
          {
            amount: 1500,
            ref: 'PW-HELD-1',
            via: 'admin approve',
            gateway: LABEL,
            refunded: true,
          },
        ],
      ]);
      expect(await breakerTripped()).toBe(false);
    });

    it('not confirmed: an ordinary refusal — waits, "not confirmed" on the row, no alert', async () => {
      const h = heldPath(regional);
      fakeGateway.refuse('refused', {
        codes: ['X1'],
        message: 'fake payout failed: insufficient',
        unconfirmedHint: true,
      });
      await expect(h.approve()).resolves.toMatchObject({ status: 'pending' });
      expect(h.packs.withdrawCreditsWithLedger).not.toHaveBeenCalled();
      expect(h.packs.updateGatewayWithdrawals.mock.calls).toEqual([
        [
          {
            selector: { id: 'gpw_h1', status: 'pending' },
            data: {
              failure_reason: expect.stringMatching(
                /^approve refused, not confirmed: left for the sweep: codes=X1/,
              ),
            },
          },
        ],
      ]);
      expect(alertPayoutFloatEmpty).not.toHaveBeenCalled();
      expect(await breakerTripped()).toBe(false);
    });
  });

  it('"no payout provider" (creates nothing): refunds, generic words, no alert, no breaker', async () => {
    const h = heldPath();
    fakeGateway.refuse('creates-nothing', { codes: ['X1'] });
    await expect(h.approve()).rejects.toThrow(ADMIN.refused);
    expect(h.packs.withdrawCreditsWithLedger.mock.calls).toEqual([
      [heldRefund],
    ]);
    expect(h.packs.updateGatewayWithdrawals.mock.calls).toEqual([
      [heldClose(/^approve refused: codes=X1\S* httpStatus=400 bankCode=MBBEMYKL msg=.*No payout provider is available/)],
    ]);
    expect(channels(h.notify)).toEqual(['email', 'customer_feed']);
    expect(alertPayoutFloatEmpty).not.toHaveBeenCalled();
    expect(alertPayoutDisabled).not.toHaveBeenCalled();
    expect(await breakerTripped()).toBe(false);
  });

  describe('any other definite refusal', () => {
    it('the gateway holds it: waits, with their id and the refusal on the pending row', async () => {
      const h = heldPath();
      fakeGateway.refuse('refused', { codes: ['X1'] });
      fakeGateway.script({ getWithdrawalDetail: detail('pending') });
      await expect(h.approve()).resolves.toEqual({
        id: 'gpw_h1',
        status: 'pending',
        transaction_id: null,
        approved: true,
      });
      expect(h.packs.withdrawCreditsWithLedger).not.toHaveBeenCalled();
      expect(h.packs.updateGatewayWithdrawals.mock.calls).toEqual([
        [
          {
            selector: { id: 'gpw_h1', status: 'pending' },
            data: {
              gateway_transaction_id: 'T-HOLD',
              failure_reason: expect.stringMatching(
                /^approve refused, but the gateway holds it: codes=X1\S* httpStatus=400 bankCode=MBBEMYKL msg=fake payout failed: refused$/,
              ),
            },
          },
        ],
      ]);
      expect(channels(h.notify)).toEqual([]);
    });

    it('the lookup answers failed: refunds, generic words, receipt and feed', async () => {
      const h = heldPath();
      fakeGateway.refuse('refused', { codes: ['X1'] });
      fakeGateway.script({ getWithdrawalDetail: detail('failed') });
      await expect(h.approve()).rejects.toThrow(ADMIN.refused);
      expect(h.packs.withdrawCreditsWithLedger.mock.calls).toEqual([
        [heldRefund],
      ]);
      expect(h.packs.updateGatewayWithdrawals.mock.calls).toEqual([
        [
          heldClose(
            /^approve refused: codes=X1\S* httpStatus=400 bankCode=MBBEMYKL msg=fake payout failed: refused$/,
          ),
        ],
      ]);
      expect(channels(h.notify)).toEqual(['email', 'customer_feed']);
      expect(alertPayoutFloatEmpty).not.toHaveBeenCalled();
    });

    it('the lookup fails: waits, nothing written to the row', async () => {
      const h = heldPath();
      fakeGateway.refuse('refused', { codes: ['X1'] });
      fakeGateway.script({ getWithdrawalDetail: LOOKUP_DOWN() });
      await expect(h.approve()).resolves.toMatchObject({ status: 'pending' });
      expect(h.packs.withdrawCreditsWithLedger).not.toHaveBeenCalled();
      expect(h.packs.updateGatewayWithdrawals).not.toHaveBeenCalled();
    });

    it('not found, unproven: waits, the "not confirmed" refusal on the row', async () => {
      const h = heldPath();
      fakeGateway.refuse('refused', { codes: ['X1'] });
      await expect(h.approve()).resolves.toMatchObject({ status: 'pending' });
      expect(h.packs.withdrawCreditsWithLedger).not.toHaveBeenCalled();
      expect(h.packs.updateGatewayWithdrawals.mock.calls).toEqual([
        [
          {
            selector: { id: 'gpw_h1', status: 'pending' },
            data: {
              failure_reason: expect.stringMatching(
                /^approve refused, not confirmed: left for the sweep: codes=X1\S* httpStatus=400 bankCode=MBBEMYKL msg=fake payout failed: refused$/,
              ),
            },
          },
        ],
      ]);
    });
  });

  it('refused before sending', async () => {
    const h = heldPath();
    fakeGateway.refuse('not-sent', { codes: ['X1'] });
    // Q4 will change this: asked, "not found" read as unproven, row left
    // pending, the admin told "approved".
    await expect(h.approve()).resolves.toEqual({
      id: 'gpw_h1',
      status: 'pending',
      transaction_id: null,
      approved: true,
    });
    expect(fakeGateway.calls.withdrawalDetails).toEqual(['PW-HELD-1']);
    expect(h.packs.withdrawCreditsWithLedger).not.toHaveBeenCalled();
    expect(h.packs.updateGatewayWithdrawals.mock.calls).toEqual([
      [
        {
          selector: { id: 'gpw_h1', status: 'pending' },
          data: {
            failure_reason: expect.stringMatching(
              /^approve refused, not confirmed: left for the sweep: codes=X1\S* httpStatus=400 bankCode=MBBEMYKL msg=Fake: cannot pay to bank/,
            ),
          },
        },
      ],
    ]);
    expect(channels(h.notify)).toEqual([]);
    expect(alertPayoutFloatEmpty).not.toHaveBeenCalled();
  });

  it.each([
    ['a lost response', () => new Error('socket hang up'), 'socket hang up'],
    [
      'a non-definite gateway answer',
      () => new GatewayError('non-JSON response', [], 503),
      'non-JSON response',
    ],
  ])('ambiguous (%s): waits, nothing written', async (_label, error, why) => {
    const h = heldPath();
    fakeGateway.script({ submitWithdrawal: error() });
    await expect(h.approve()).resolves.toEqual({
      id: 'gpw_h1',
      status: 'pending',
      transaction_id: null,
      approved: true,
    });
    expect(h.packs.withdrawCreditsWithLedger).not.toHaveBeenCalled();
    expect(h.packs.updateGatewayWithdrawals).not.toHaveBeenCalled();
    expect(h.logger.error.mock.calls).toEqual([
      [
        `[payments] admin usr_admin_1 approved withdrawal PW-HELD-1 but the submit outcome is AMBIGUOUS (${why}) — left pending for the sweep`,
      ],
    ]);
    expect(alertPayoutFloatEmpty).not.toHaveBeenCalled();
  });

  it('while the wallet breaker is tripped', async () => {
    // Trip it the way production does: a customer's payout refused for an
    // empty wallet.
    fakeGateway.refuse('wallet-empty', { codes: ['X1'] });
    await newPath().start().catch(() => undefined);
    fakeGateway.script({ submitWithdrawal: { transactionId: 'W-OK-2' } });
    const h = heldPath();
    // Q7 will change this: claimed and submitted regardless of the breaker.
    await expect(h.approve()).resolves.toMatchObject({
      status: 'pending',
      transaction_id: 'W-OK-2',
    });
    expect(h.packs.claimWithdrawalAgainstDebit).toHaveBeenCalledTimes(1);
    expect(fakeGateway.calls.withdrawals).toHaveLength(2);
  });
});

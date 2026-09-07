import { banksFor } from './banks';
import type { GatewayAdapter } from './gateway';
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

// The second adapter behind the seam in gateway.ts — the one the tests use.
//
// Every money path (gateway-deposit, gateway-withdrawal, the sweeps, the
// admin routes) already dispatches on a config's `kind`. Before this file
// there was exactly one kind, so specs reached PAST that dispatch with
// jest.mock('…/gateway') and replaced the seam's own functions. That proves
// nothing about the seam: a spec could stay green while the dispatch, the
// registry, or the per-row config lookup was broken.
//
// So: a real second gateway, selected the real way (PAYMENT_GATEWAY=fake or
// the admin setting -> resolveActiveGateway -> gatewayConfigFor -> adapterFor)
// and scripted per operation. It performs no I/O and it is unreachable off
// NODE_ENV=test — see isPaymentGateway / GATEWAYS.fake in gateway.ts.

export type FakeConfig = { kind: 'fake' };

/**
 * What one operation does next:
 * - `'ok'` (or nothing scripted) — the canonical well-formed result below;
 * - an `Error` — thrown as-is, so a `GatewayError`'s `definite` flag reaches
 *   the caller's refund branch and a plain `Error` exercises the ambiguous
 *   one;
 * - an object — handed back VERBATIM, not merged over the canonical result:
 *   money callers branch on a MISSING field (an unknown net, an absent
 *   amount), so filling one in would change what the subject sees;
 * - a function — run, for a spec that needs to observe ordering or throw
 *   conditionally.
 * Default detail amounts are zero. Tests expecting settlement must script
 * a positive detail amount (and any net amount the scenario needs).
 */
export type FakeOutcome<R> =
  'ok' | Error | Partial<R> | (() => Partial<R> | Promise<Partial<R>>);

export type FakeScript = {
  submitDeposit?: FakeOutcome<SubmitDepositResult>;
  getDepositDetail?: FakeOutcome<DepositDetail>;
  submitWithdrawal?: FakeOutcome<SubmitWithdrawalResult>;
  getWithdrawalDetail?: FakeOutcome<WithdrawalDetail>;
  checkBalance?: FakeOutcome<MerchantBalance>;
};

export type FakeCalls = {
  deposits: SubmitDepositInput[];
  withdrawals: SubmitWithdrawalInput[];
  /** The merchant reference each requery asked about. */
  depositDetails: string[];
  withdrawalDetails: string[];
  balances: FakeConfig[];
};

/** Exactly what TGPay pays to — see the `fake` code in banks.ts. */
const FAKE_BANKS: SupportedBank[] = banksFor('fake');

/** The wallet an `'ok'` balance read reports. Script it to assert on values. */
const FAKE_BALANCE: MerchantBalance = {
  merchantCode: 'fake',
  currencyCode: 'MYR',
  currentBalance: 1_000_000,
  availableBalance: 1_000_000,
  t1Balance: 0,
  notes: [],
};

let script: FakeScript = {};
let seq = 0;
const calls: FakeCalls = {
  deposits: [],
  withdrawals: [],
  depositDetails: [],
  withdrawalDetails: [],
  balances: [],
};

async function play<R>(
  outcome: FakeOutcome<R> | undefined,
  ok: () => R,
): Promise<R> {
  if (outcome === undefined || outcome === 'ok') return ok();
  if (outcome instanceof Error) throw outcome;
  // The cast is the point of the verbatim rule: a script may be a PARTIAL
  // result, and the caller must meet exactly the shape the spec wrote.
  if (typeof outcome === 'function') return (await outcome()) as R;
  return outcome as R;
}

const adapter: GatewayAdapter<FakeConfig> = {
  async submitDeposit(input) {
    calls.deposits.push(input);
    return play(script.submitDeposit, () => ({
      transactionId: `FAKE-D-${++seq}`,
      url: `https://fake-gateway.test/checkout/${input.merchantTransactionId}`,
      depositActualAmount: input.amount,
    }));
  },

  async getDepositDetail(merchantTransactionId) {
    calls.depositDetails.push(merchantTransactionId);
    return play(script.getDepositDetail, () => ({
      transactionId: `FAKE-D-${++seq}`,
      merchantTransactionId,
      statusId: null,
      status: 'SUCCESS',
      amount: 0,
      netAmount: 0,
      paymentMethodCode: 'FPX',
      bankReferenceNo: null,
      uniqueReferenceNo: null,
      state: 'success',
    }));
  },

  async submitWithdrawal(input) {
    calls.withdrawals.push(input);
    return play(script.submitWithdrawal, () => ({
      transactionId: `FAKE-W-${++seq}`,
    }));
  },

  async getWithdrawalDetail(merchantTransactionId) {
    calls.withdrawalDetails.push(merchantTransactionId);
    return play(script.getWithdrawalDetail, () => ({
      transactionId: `FAKE-W-${++seq}`,
      merchantTransactionId,
      statusId: null,
      status: 'SUCCESS',
      amount: 0,
      netAmount: 0,
      paymentMethodCode: 'WD',
      bankReferenceNo: null,
      uniqueReferenceNo: null,
      state: 'success',
    }));
  },

  async getSupportedBanks() {
    return FAKE_BANKS;
  },

  async checkBalance(config) {
    calls.balances.push(config);
    return play(script.checkBalance, () => ({ ...FAKE_BALANCE }));
  },
};

/**
 * The scripting surface. `script()` MERGES, so setting one operation leaves
 * the others on their canonical behaviour; `reset()` (call it in a
 * `beforeEach`) drops the script, the call log and the id counter, because
 * the adapter is module state shared by every test in a file.
 */
export const fakeGateway: GatewayAdapter<FakeConfig> & {
  script: (next: FakeScript) => void;
  reset: () => void;
  calls: FakeCalls;
} = {
  ...adapter,
  script(next) {
    script = { ...script, ...next };
  },
  reset() {
    script = {};
    seq = 0;
    calls.deposits = [];
    calls.withdrawals = [];
    calls.depositDetails = [];
    calls.withdrawalDetails = [];
    calls.balances = [];
  },
  calls,
};

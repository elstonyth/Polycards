import {
  GLOBEPAY_DEFAULT_METHOD,
  globepayEnabled,
  newMerchantTransactionId,
  startGlobePayDeposit,
} from '../globepay-deposit';

// startGlobePayDeposit talks to the gateway through the seam in gateway.ts;
// stub that so these tests cover the state machine (row before call, row
// closed on failure, id stamped on success) rather than the adapter or the
// HTTP layer, which have their own specs.
jest.mock('../gateway', () => {
  const actual = jest.requireActual('../gateway');
  return { ...actual, submitDeposit: jest.fn() };
});

import { GatewayError, submitDeposit } from '../gateway';
import {
  GLOBEPAY_MAX_RECENT_PENDING_PER_CUSTOMER,
  GLOBEPAY_PENDING_WINDOW_MS,
} from '../globepay-deposit';

const submitMock = submitDeposit as jest.Mock;

function harness() {
  const packs = {
    // The cap and the insert are ONE customer-locked service call (#429): null
    // back means the cap refused, and no row was written. Default is a
    // successful insert so every existing case behaves as it did before the cap.
    createGlobePayDepositCapped: jest.fn().mockResolvedValue({ id: 'gpd_1' }),
    updateGlobePayDeposits: jest.fn().mockResolvedValue(undefined),
  };
  // Resolve BY KEY. The old stub returned `packs` for every key, which passed
  // only because the subject resolved one dependency; the first call to
  // resolve('logger') then blew up with "warn is not a function" inside the
  // refusal path. Same shape as api/hooks/tgpay/deposit's spec.
  const logger = { warn: jest.fn(), error: jest.fn(), info: jest.fn() };
  return {
    packs,
    logger,
    scope: {
      resolve: (key: string) => (key === 'logger' ? logger : packs),
    } as never,
  };
}

const input = {
  customerId: 'cus_1',
  amount: 50,
  ipAddress: '1.2.3.4',
};

const start = (
  h: ReturnType<typeof harness>,
  over: Record<string, unknown> = {},
) =>
  startGlobePayDeposit(
    h.scope,
    { ...input, ...over },
    'https://us/notify',
    'https://us/return',
  );

beforeEach(() => {
  submitMock.mockReset();
  submitMock.mockResolvedValue({
    transactionId: 'D2026072112415767',
    url: 'https://cashier/x',
    depositActualAmount: 50,
  });
  process.env.GLOBEPAY_ENABLED = 'true';
  process.env.TGPAY_API_BASE = 'https://sandbox-api.example.test/api/v2';
  process.env.TGPAY_PUBLIC_KEY = 'pk-test';
  process.env.TGPAY_SECRET_KEY = 'sk-test';
});

describe('globepayEnabled', () => {
  it('is off unless explicitly enabled AND the active gateway is configured', () => {
    expect(globepayEnabled({})).toBe(false);
    expect(globepayEnabled({ GLOBEPAY_ENABLED: 'true' })).toBe(false);
    expect(globepayEnabled({ TGPAY_SECRET_KEY: 'sk' })).toBe(false);
    expect(
      globepayEnabled({ GLOBEPAY_ENABLED: 'true', TGPAY_SECRET_KEY: 'sk' }),
    ).toBe(true);
  });
});

describe('newMerchantTransactionId', () => {
  it('is opaque and unique — it is shown in THEIR back office', () => {
    const a = newMerchantTransactionId();
    const b = newMerchantTransactionId();
    expect(a).not.toBe(b);
    expect(a.startsWith('PC-')).toBe(true);
    // No customer id smuggled in: the row is what maps it back.
    expect(a).not.toMatch(/cus_/);
  });
});

describe('startGlobePayDeposit', () => {
  it('writes the pending row BEFORE calling the gateway', async () => {
    const h = harness();
    const order: string[] = [];
    h.packs.createGlobePayDepositCapped.mockImplementation(async () => {
      order.push('row');
      return { id: 'gpd_1' };
    });
    submitMock.mockImplementation(async () => {
      order.push('gateway');
      return { transactionId: 'D1', url: 'u', depositActualAmount: 50 };
    });

    await start(h);
    // Reversed, a callback could arrive for a reference we have no record of.
    expect(order).toEqual(['row', 'gateway']);
  });

  it('stamps their transaction id on the row after a successful submit', async () => {
    const h = harness();
    const result = await start(h);
    expect(h.packs.updateGlobePayDeposits).toHaveBeenCalledWith({
      id: 'gpd_1',
      gateway_transaction_id: 'D2026072112415767',
    });
    expect(result.url).toBe('https://cashier/x');
    expect(result.merchantTransactionId).toBe(
      h.packs.createGlobePayDepositCapped.mock.calls[0][0].data
        .merchant_transaction_id,
    );
  });

  it('defaults to the provisioned method and passes the CUSTOMER ip', async () => {
    const h = harness();
    await start(h);
    expect(submitMock).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentMethodCode: GLOBEPAY_DEFAULT_METHOD,
        ipAddress: '1.2.3.4',
        notifyUrl: 'https://us/notify',
      }),
      expect.anything(),
    );
  });

  describe('payment method allow-list', () => {
    it('forwards a named rail', async () => {
      const h = harness();
      await start(h, { paymentMethodCode: 'FPX' });
      expect(submitMock).toHaveBeenCalledWith(
        expect.objectContaining({ paymentMethodCode: 'FPX' }),
        expect.anything(),
      );
    });

    it('refuses an unknown rail instead of forwarding it', async () => {
      const h = harness();
      await expect(start(h, { paymentMethodCode: 'NOPE' })).rejects.toThrow(
        /unsupported payment method/i,
      );
      expect(submitMock).not.toHaveBeenCalled();
    });
  });

  it('closes the row out when the gateway refuses, so it never lingers pending', async () => {
    const h = harness();
    // definite=true — a parsed refusal. Only those close the row; see the
    // definite=false case below.
    submitMock.mockRejectedValue(
      new GatewayError('nope', ['PMT10005'], 200, true),
    );
    await expect(start(h)).rejects.toThrow(/could not start your top-up/i);
    expect(h.packs.updateGlobePayDeposits).toHaveBeenCalledWith({
      id: 'gpd_1',
      status: 'failed',
    });
  });

  // The refusal reason exists ONLY in this log line: the row keeps no code and
  // the customer-facing message is deliberately generic. Both the codes and the
  // message must survive — a refusal carrying no code puts its whole diagnosis
  // in the message.
  it('logs the gateway codes AND message before flattening the refusal', async () => {
    const h = harness();
    submitMock.mockRejectedValue(
      new GatewayError('Invalid Payment Method.', ['PMT10006'], 400, true),
    );
    await expect(start(h)).rejects.toThrow(/could not start your top-up/i);
    const line = h.logger.warn.mock.calls[0][0] as string;
    expect(line).toContain('codes=PMT10006');
    expect(line).toContain('httpStatus=400');
    expect(line).toContain('msg=Invalid Payment Method.');
    // Money-path state is written even if logging is broken, so the row update
    // must not sit behind the logger call.
    expect(h.packs.updateGlobePayDeposits).toHaveBeenCalledWith({
      id: 'gpd_1',
      status: 'failed',
    });
  });

  // The log is diagnostics; the MedusaError is the customer's instruction. A
  // logger that throws must not be able to swap one for the other — before the
  // try/catch it escaped this branch and the caller saw the logger's crash
  // instead, turning a 400 with actionable copy into an opaque 500.
  it('still refuses with the customer-facing message when the logger throws', async () => {
    const h = harness();
    h.logger.warn.mockImplementation(() => {
      throw new Error('logger exploded');
    });
    submitMock.mockRejectedValue(
      new GatewayError('nope', ['PMT10005'], 200, true),
    );
    await expect(start(h)).rejects.toThrow(/could not start your top-up/i);
    // Self-contained on purpose: without this the test would still pass if the
    // log were deleted outright, and the deletion is the regression it exists
    // to catch.
    expect(h.logger.warn).toHaveBeenCalled();
    // And the row was still closed, so the sweep is not left chasing it.
    expect(h.packs.updateGlobePayDeposits).toHaveBeenCalledWith({
      id: 'gpd_1',
      status: 'failed',
    });
  });

  // The ambiguous branch is the one that LEAVES a row behind. Medusa's default
  // handler logs the bare error message with no reference, so this line is the
  // only thing that ties the pending row to the cause that created it.
  it('names the reference when it leaves a row pending for the sweep', async () => {
    const h = harness();
    submitMock.mockRejectedValue(new Error('socket hang up'));
    await expect(start(h)).rejects.toThrow(/socket hang up/);
    const line = h.logger.error.mock.calls[0][0] as string;
    expect(line).toContain('AMBIGUOUS');
    expect(line).toContain('socket hang up');
    expect(line).toMatch(/deposit PC-/);
    // Still pending: closing it here would drop a live payment out of the
    // sweep's status='pending' scan permanently.
    expect(h.packs.updateGlobePayDeposits).not.toHaveBeenCalled();
  });

  it('still rethrows the gateway error when the AMBIGUOUS logger throws', async () => {
    // The gateway error is what the operator needs; the logger must not be
    // able to replace it with its own.
    const h = harness();
    h.logger.error.mockImplementation(() => {
      throw new Error('logger exploded');
    });
    submitMock.mockRejectedValue(new Error('socket hang up'));
    await expect(start(h)).rejects.toThrow(/socket hang up/);
    expect(h.packs.updateGlobePayDeposits).not.toHaveBeenCalled();
  });

  // The other half of that rule, and the one that costs real money if it is
  // wrong. A timeout/socket reset/WAF page does NOT mean the gateway refused —
  // the submit may have landed. The reconciliation sweep only scans
  // status='pending', so marking this row 'failed' would take a live deposit
  // out of requery forever and strand whatever the customer paid.
  //
  // The GlobePayError case is the one that matters and the one that used to be
  // missing: the client wraps a non-JSON/WAF response in GlobePayError with
  // definite=false, so a test that only mocked a raw SyntaxError (a shape the
  // client never throws) passed while production closed those rows anyway.
  it.each([
    ['a timeout', new Error('ETIMEDOUT')],
    [
      'a WAF page the client could not parse',
      new GatewayError('<html>Access denied for this IP</html>', [], 403),
    ],
  ])(
    'leaves the row pending on %s, so the sweep can still requery it',
    async (_label, error) => {
      const h = harness();
      submitMock.mockRejectedValue(error);
      await expect(start(h)).rejects.toThrow(error);
      expect(h.packs.updateGlobePayDeposits).not.toHaveBeenCalled();
    },
  );

  it('rejects an invalid amount before touching the gateway', async () => {
    const h = harness();
    await expect(start(h, { amount: -5 })).rejects.toThrow(
      /greater than zero/i,
    );
    expect(submitMock).not.toHaveBeenCalled();
    expect(h.packs.createGlobePayDepositCapped).not.toHaveBeenCalled();
  });

  // The active gateway's band (TGPay: RM 50 floor, read from the production
  // tenant 2026-09-06), checked before the network call: a doomed request
  // would still leave a failed row, and the gateway's refusal names no numbers.
  it.each([29, 49])(
    'rejects RM %s — outside the gateway band — without calling the gateway',
    async (amount) => {
      const h = harness();
      await expect(start(h, { amount })).rejects.toThrow(
        /between RM 50 and RM 10,000/,
      );
      expect(submitMock).not.toHaveBeenCalled();
      expect(h.packs.createGlobePayDepositCapped).not.toHaveBeenCalled();
    },
  );

  // The production ceiling now coincides with the site-wide TOPUP_MAX_RM, which
  // is checked first — so over-the-top amounts are refused with THAT wording.
  // Same outcome, different sentence; pinned so a future change to either
  // number cannot silently let one through.
  it.each([10001, 50000])(
    'rejects RM %s at the site-wide top-up ceiling, before the gateway',
    async (amount) => {
      const h = harness();
      await expect(start(h, { amount })).rejects.toThrow(
        /at most RM 10,000 per top-up/,
      );
      expect(submitMock).not.toHaveBeenCalled();
      expect(h.packs.createGlobePayDepositCapped).not.toHaveBeenCalled();
    },
  );

  it.each([50, 10000])(
    'accepts RM %s — the exact band edges',
    async (amount) => {
      const h = harness();
      await expect(start(h, { amount })).resolves.toBeTruthy();
    },
  );

  it('rejects a payment method outside the MYR allow-list', async () => {
    const h = harness();
    // UPI is an INR method — asking for it here would depend on gateway-side
    // behaviour we cannot see.
    await expect(start(h, { paymentMethodCode: 'UPI' })).rejects.toThrow(
      /unsupported payment method/i,
    );
    expect(submitMock).not.toHaveBeenCalled();
    expect(h.packs.createGlobePayDepositCapped).not.toHaveBeenCalled();
  });

  it('accepts every documented MYR method', async () => {
    for (const method of ['FPX', 'DN', 'BQR', 'OB']) {
      const h = harness();
      await expect(
        start(h, { paymentMethodCode: method }),
      ).resolves.toBeTruthy();
    }
  });

  it('refuses to run when the gateway is not enabled', async () => {
    process.env.GLOBEPAY_ENABLED = 'false';
    const h = harness();
    await expect(start(h)).rejects.toThrow(/temporarily unavailable/i);
    expect(submitMock).not.toHaveBeenCalled();
  });
});

// The reconcile sweep selects pending deposits oldest-first with a fixed LIMIT,
// and in production it is the ONLY writer that credits a paid deposit. A
// customer looping unpaid cashier sessions could hold the front of that queue
// and starve everyone else's real payments, so the row insert is capped.
describe('startGlobePayDeposit — pending-deposit cap', () => {
  it('refuses when the capped insert reports the cap was reached', async () => {
    const h = harness();
    h.packs.createGlobePayDepositCapped.mockResolvedValue(null);

    await expect(start(h)).rejects.toThrow(/waiting for payment/i);

    // Nothing was written (the service refused under its lock) and nothing
    // reached the gateway — otherwise the cap would create the very backlog it
    // exists to prevent.
    expect(submitMock).not.toHaveBeenCalled();
  });

  it('proceeds when the capped insert returns a row', async () => {
    const h = harness();

    await expect(start(h)).resolves.toBeTruthy();
    expect(h.packs.createGlobePayDepositCapped).toHaveBeenCalled();
    expect(submitMock).toHaveBeenCalled();
  });

  it('hands the service the policy: this customer, the cap, the window', async () => {
    const h = harness();
    await start(h);

    // The count itself (status='pending', created_at window) lives inside the
    // locked transaction now — globepay-deposit-cap-lock.unit.spec.ts pins that
    // half. What this file still owns is the policy the module passes down.
    const arg = h.packs.createGlobePayDepositCapped.mock.calls[0][0];
    expect(arg.data.customer_id).toBe(input.customerId);
    expect(arg.data.status).toBe('pending');
    expect(arg.maxRecentPending).toBe(GLOBEPAY_MAX_RECENT_PENDING_PER_CUSTOMER);
    // Window-scoped on purpose: there is no customer-facing cancel endpoint, so
    // an unscoped cap would lock out someone who merely closed a few cashier
    // tabs until the sweep expired their rows.
    expect(arg.windowMs).toBe(GLOBEPAY_PENDING_WINDOW_MS);
  });
});

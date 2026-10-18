import {
  GATEWAYS,
  LEDGER_GATEWAY_IDS,
  isLedgerGateway,
  paymentGateway,
  setActiveGateway,
} from '../gateway';
import {
  isPayinVerifyFail,
  regionalDepositGateway,
} from '../gateway-deposit';
import {
  payoutCurrencyFor,
  payoutGatewayFor,
  regionalPayoutGateways,
} from '../gateway-withdrawal';
import { regionalDepositBand } from '../payment-fx';

// A3Pay (SGD) runs BESIDE the active RM gateway and must never become it:
// that would send every RM top-up to an SGD rail.

const A3PAY_ENV = {
  GATEWAY_ENABLED: 'true',
  GATEWAY_WITHDRAWALS_ENABLED: 'true',
  A3PAY_ENABLED: 'true',
  A3PAY_API_BASE: 'https://mapi.example.test',
  A3PAY_MERCHANT_CODE: 'SGD00001',
  A3PAY_AES_KEY: 'k',
  A3PAY_MERCHANT_PRIVATE_KEY: 'priv',
  A3PAY_PUBLIC_KEY: 'pub',
};

afterEach(() => setActiveGateway(null));

describe('A3Pay never holds the active (RM) slot', () => {
  it('is not offered to the admin switch', () => {
    expect(isLedgerGateway('a3pay')).toBe(false);
    expect(LEDGER_GATEWAY_IDS).not.toContain('a3pay');
    expect(LEDGER_GATEWAY_IDS).toContain('tgpay');
  });

  it('setActiveGateway refuses it outright', () => {
    expect(() => setActiveGateway('a3pay')).toThrow(/only an RM gateway/);
    expect(paymentGateway({})).toBe('tgpay');
  });

  it('PAYMENT_GATEWAY=a3pay falls back to the RM default', () => {
    expect(paymentGateway({ PAYMENT_GATEWAY: 'a3pay' })).toBe('tgpay');
  });
});

describe('routing to the regional rail', () => {
  it('an SGD top-up goes to A3Pay only while it is switched on', () => {
    expect(regionalDepositGateway('SGD', A3PAY_ENV)).toBe('a3pay');
    expect(regionalDepositGateway('sgd', A3PAY_ENV)).toBe('a3pay');
    expect(
      regionalDepositGateway('SGD', { ...A3PAY_ENV, A3PAY_ENABLED: 'false' }),
    ).toBeNull();
    expect(regionalDepositGateway('USD', A3PAY_ENV)).toBeNull();
  });

  it('a Singapore bank is paid by A3Pay, a Malaysian one by the active gateway', () => {
    expect(regionalPayoutGateways(A3PAY_ENV)).toEqual(['a3pay']);
    expect(payoutGatewayFor('DBSSSGSG', 'tgpay', A3PAY_ENV)).toBe('a3pay');
    expect(payoutGatewayFor('MBBEMYKL', 'tgpay', A3PAY_ENV)).toBe('tgpay');
    // Switched off: the Singapore bank falls back to the active gateway,
    // whose own bank check then refuses it before any debit.
    expect(payoutGatewayFor('DBSSSGSG', 'tgpay', {})).toBe('tgpay');
  });

  // The currency is the bank's, not the rail's state: a saved Singapore bank
  // stays SGD while A3Pay is switched off, so the storefront files it under
  // Singapore (shown unavailable) rather than under Malaysia.
  it('a Singapore bank stays SGD whether or not its rail is open', () => {
    expect(payoutCurrencyFor('DBSSSGSG', 'tgpay', A3PAY_ENV)).toBe('SGD');
    expect(payoutCurrencyFor('DBSSSGSG', 'tgpay', {})).toBe('SGD');
    expect(payoutCurrencyFor('ALLIANCESG', 'tgpay', {})).toBe('SGD');
    expect(payoutCurrencyFor('MBBEMYKL', 'tgpay', {})).toBe('MYR');
    expect(payoutCurrencyFor('NOT_A_BANK', 'tgpay', {})).toBe('MYR');
  });

  it('A3Pay carries an SGD band and RM fences', () => {
    expect(GATEWAYS.a3pay.currency).toBe('SGD');
    expect(GATEWAYS.a3pay.currencyLimits?.depositMax).toBeGreaterThan(0);
    // S$30 both ways: our top-up floor (A3Pay takes S$10), and the payout
    // floor A3Pay lowered for us on 2026-10-12.
    expect(GATEWAYS.a3pay.currencyLimits?.depositMin).toBe(30);
    expect(GATEWAYS.a3pay.currencyLimits?.withdrawalMin).toBe(30);
    // Its RM top-up ceiling sits above the RM gateway's (operator decision,
    // 2026-10-14) so the S$ band reaches A3Pay's own S$5,000 at any rate
    // under RM 4 per S$, nudge included.
    expect(GATEWAYS.a3pay.limits.depositMax).toBeGreaterThan(
      GATEWAYS.tgpay.limits.depositMax,
    );
    for (const depositRate of [3.0, 3.17, 3.5, 3.99]) {
      expect(
        regionalDepositBand(
          { depositRate },
          GATEWAYS.a3pay.currencyLimits!,
          GATEWAYS.a3pay.limits,
        ).max,
      ).toBe(5000);
    }
    expect(GATEWAYS.a3pay.hooks.payoutVerify).toBe(
      '/hooks/a3pay/payout-verify',
    );
  });
});

describe('Verify Fail (payin status 4)', () => {
  it('is an A3Pay status only, read from a number or a string', () => {
    expect(isPayinVerifyFail('a3pay', 4)).toBe(true);
    expect(isPayinVerifyFail('a3pay', '4')).toBe(true);
    expect(isPayinVerifyFail('a3pay', 6)).toBe(false);
    expect(isPayinVerifyFail('tgpay', 4)).toBe(false);
    expect(isPayinVerifyFail(null, 4)).toBe(false);
  });
});

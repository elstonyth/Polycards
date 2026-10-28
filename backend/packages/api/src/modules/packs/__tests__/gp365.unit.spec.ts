import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { aesDecrypt } from '../a3pay';
import {
  a3payConfigFromEnv,
  a3payFamilyConfigFromEnv,
  a3payFamilyConfigured,
} from '../a3pay-client';
import {
  findBank,
  gatewayBankCode,
  banksFor,
  walletAddressValid,
} from '../banks';
import {
  GATEWAYS,
  REGIONAL_CURRENCIES,
  isLedgerGateway,
  submitDeposit,
  submitWithdrawal,
  type GatewayConfig,
} from '../gateway';
import { isPayinVerifyFail, regionalDepositGateway } from '../gateway-deposit';
import { savedBankAccountViews } from '../saved-accounts';
import {
  payoutFloatNeeded,
  payoutGatewayFor,
  regionalPayoutGateways,
  withdrawalDetailsError,
} from '../gateway-withdrawal';
import { PAYMENT_FX_FEEDS } from '../payment-fx';

// GlobePay365 (USDT): a second tenant of the A3Pay platform, beside A3Pay.

const ours = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'der' },
  privateKeyEncoding: { type: 'pkcs8', format: 'der' },
});

const GP365_ENV = {
  GATEWAY_ENABLED: 'true',
  GATEWAY_WITHDRAWALS_ENABLED: 'true',
  GP365_ENABLED: 'true',
  GP365_API_BASE: 'https://mapi.globepay365stg.test',
  GP365_MERCHANT_CODE: 'GP00001',
  GP365_AES_KEY: 'gp-aes',
  GP365_MERCHANT_PRIVATE_KEY: ours.privateKey.toString('base64'),
  GP365_PUBLIC_KEY: ours.publicKey.toString('base64'),
};

// Real, well-known addresses: Tether's own USDT contracts on each chain.
const TRON = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const EVM = '0xdAC17F958D2ee523a2206206994597C13D831ec7';

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(bytes: Buffer): string {
  let n = BigInt(`0x${bytes.toString('hex')}`);
  let out = '';
  while (n > BigInt(0)) {
    out = BASE58[Number(n % BigInt(58))] + out;
    n /= BigInt(58);
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}
const sha = (b: Buffer) => createHash('sha256').update(b).digest();
function tronAddress(): string {
  const body = Buffer.concat([Buffer.from([0x41]), randomBytes(20)]);
  return base58(Buffer.concat([body, sha(sha(body)).subarray(0, 4)]));
}

describe('GlobePay365 config — its own GP365_* keys', () => {
  it('reads GP365_* and settles in USDT by default', () => {
    const config = a3payFamilyConfigFromEnv('gp365', GP365_ENV);
    expect(config).toMatchObject({
      kind: 'gp365',
      baseUrl: 'https://mapi.globepay365stg.test',
      merchantCode: 'GP00001',
      currencyCode: 'USDT',
    });
    expect(a3payFamilyConfigured('gp365', GP365_ENV)).toBe(true);
  });

  it("never borrows A3Pay's keys, and A3Pay never borrows its", () => {
    expect(() => a3payFamilyConfigFromEnv('gp365', {})).toThrow(
      /GlobePay365: missing required env var GP365_API_BASE/,
    );
    expect(() => a3payConfigFromEnv(GP365_ENV)).toThrow(/A3PAY_API_BASE/);
    expect(a3payFamilyConfigured('gp365', { A3PAY_API_BASE: 'x' })).toBe(false);
  });

  it('refuses a staging host in production, and any CurrCode but its own', () => {
    expect(() =>
      a3payFamilyConfigFromEnv('gp365', {
        ...GP365_ENV,
        NODE_ENV: 'production',
      }),
    ).toThrow(/staging host in production/);
    expect(
      a3payFamilyConfigFromEnv('gp365', {
        ...GP365_ENV,
        NODE_ENV: 'production',
        GP365_API_BASE: 'https://mapi.globepay365.com',
      }).baseUrl,
    ).toBe('https://mapi.globepay365.com');
    expect(() =>
      a3payFamilyConfigFromEnv('gp365', {
        ...GP365_ENV,
        GP365_CURRENCY: 'USD',
      }),
    ).toThrow(/GP365_CURRENCY must be USDT/);
    // Production's A3Pay host and its explicit A3PAY_CURRENCY=SGD still load.
    expect(
      a3payConfigFromEnv({
        NODE_ENV: 'production',
        A3PAY_API_BASE: 'https://mapi.a3paysg.com',
        A3PAY_MERCHANT_CODE: 'polycards',
        A3PAY_AES_KEY: 'k',
        A3PAY_MERCHANT_PRIVATE_KEY: 'k',
        A3PAY_PUBLIC_KEY: 'k',
        A3PAY_CURRENCY: 'SGD',
      }).currencyCode,
    ).toBe('SGD');
  });

  it('switched on only by GP365_ENABLED, beside the RM gateway', () => {
    expect(GATEWAYS.gp365.configured(GP365_ENV)).toBe(true);
    expect(
      GATEWAYS.gp365.configured({ ...GP365_ENV, GP365_ENABLED: 'false' }),
    ).toBe(false);
    expect(isLedgerGateway('gp365')).toBe(false);
    expect(REGIONAL_CURRENCIES).toEqual(
      expect.arrayContaining(['SGD', 'USDT']),
    );
    // Coinbase quotes USDT itself; ECB USD is the labelled proxy fallback.
    expect(PAYMENT_FX_FEEDS.USDT.url).toMatch(/coinbase.com.*currency=USDT/);
    expect(PAYMENT_FX_FEEDS.USDT.fallbackUrl).toMatch(/from=USD&to=MYR/);
    expect(PAYMENT_FX_FEEDS.USDT.fallbackQuotes).toBe('USD');
  });
});

describe('routing — a USDT top-up and a wallet payout go to GlobePay365', () => {
  it('USDT top-ups only while it is switched on', () => {
    expect(regionalDepositGateway('USDT', GP365_ENV)).toBe('gp365');
    expect(
      regionalDepositGateway('USDT', { ...GP365_ENV, GP365_ENABLED: 'false' }),
    ).toBeNull();
    expect(regionalDepositGateway('SGD', GP365_ENV)).toBeNull();
  });

  it('the USDT payout floor, not the RM one, is what binds', () => {
    // At any plausible rate (>= RM 4 per USDT) USDT 10 is above the RM floor.
    expect(GATEWAYS.gp365.limits.withdrawalMin).toBeLessThan(
      GATEWAYS.gp365.currencyLimits!.withdrawalMin * 4,
    );
  });

  it('Verify Fail (payin 4) is recognised for the A3Pay platform only', () => {
    expect(isPayinVerifyFail('gp365', 4)).toBe(true);
    expect(isPayinVerifyFail('a3pay', '4')).toBe(true);
    expect(isPayinVerifyFail('gp365', 6)).toBe(false);
    expect(isPayinVerifyFail('tgpay', 4)).toBe(false);
    expect(isPayinVerifyFail(null, 4)).toBe(false);
  });

  it('a wallet is paid by GlobePay365, a bank never is', () => {
    expect(regionalPayoutGateways(GP365_ENV)).toEqual(['gp365']);
    expect(payoutGatewayFor('USDTTRC20', 'tgpay', GP365_ENV)).toBe('gp365');
    expect(payoutGatewayFor('USDTERC20', 'tgpay', GP365_ENV)).toBe('gp365');
    expect(payoutGatewayFor('MBBEMYKL', 'tgpay', GP365_ENV)).toBe('tgpay');
    expect(payoutGatewayFor('DBSSSGSG', 'tgpay', GP365_ENV)).toBe('tgpay');
  });
});

describe('USDT wallets in the bank registry', () => {
  it('map to the payout codes the doc names, by canonical id only', () => {
    expect(gatewayBankCode('USDTTRC20', 'gp365')?.code).toBe('USDTTRC');
    expect(gatewayBankCode('USDTERC20', 'gp365')?.code).toBe('USDTERC');
    // Their codes are not aliases, and no other gateway can pay a wallet.
    expect(findBank('USDTTRC')).toBeNull();
    expect(gatewayBankCode('USDTTRC20', 'a3pay')).toBeNull();
    expect(gatewayBankCode('USDTTRC20', 'tgpay')).toBeNull();
    expect(banksFor('gp365').map((b) => b.bankCode)).toEqual([
      'USDTTRC20',
      'USDTERC20',
    ]);
    expect(banksFor('a3pay').map((b) => b.bankCode)).not.toContain('USDTTRC20');
  });

  it('checks a Tron address checksum, not just its shape', () => {
    expect(walletAddressValid('tron', TRON)).toBe(true);
    for (let i = 0; i < 20; i++)
      expect(walletAddressValid('tron', tronAddress())).toBe(true);
    // One character changed: same shape, broken checksum.
    const typo = `${TRON.slice(0, 10)}${TRON[10] === 'a' ? 'b' : 'a'}${TRON.slice(11)}`;
    expect(walletAddressValid('tron', typo)).toBe(false);
    expect(walletAddressValid('tron', TRON.toLowerCase())).toBe(false);
    expect(walletAddressValid('tron', EVM)).toBe(false);
    expect(walletAddressValid('tron', `${TRON} `)).toBe(false);
  });

  it('checks an EVM address with its EIP-55 checksum', () => {
    // EIP-55's own test vectors, plus Tether's contract.
    for (const address of [
      EVM,
      '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
      '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
      '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB',
      '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb',
    ])
      expect(walletAddressValid('evm', address)).toBe(true);
    // One hex digit mistyped in a checksummed address: refused.
    expect(
      walletAddressValid('evm', '0xdAC17F958D2ee523a2206206994597C13D831ec8'),
    ).toBe(false);
    // One letter's case flipped: refused.
    expect(
      walletAddressValid('evm', '0xDAC17F958D2ee523a2206206994597C13D831ec7'),
    ).toBe(false);
    // One case throughout carries no checksum: accepted on shape (EIP-55).
    expect(walletAddressValid('evm', EVM.toLowerCase())).toBe(true);
    expect(walletAddressValid('evm', `0x${EVM.slice(2).toUpperCase()}`)).toBe(
      true,
    );
    expect(walletAddressValid('evm', EVM.slice(0, -1))).toBe(false);
    expect(walletAddressValid('evm', `0x${'g'.repeat(40)}`)).toBe(false);
    expect(walletAddressValid('evm', TRON)).toBe(false);
  });

  it('saved-account views flag wallets, never banks', () => {
    const views = savedBankAccountViews(
      [
        {
          id: 'a',
          bankCode: 'USDTTRC20',
          bankName: 'USDT · TRC20 (Tron)',
          accountNumber: TRON,
          accountHolderName: 'USDT · TRC20 (Tron)',
        },
        {
          id: 'b',
          bankCode: 'MBBEMYKL',
          bankName: 'Maybank',
          accountNumber: '12345678',
          accountHolderName: 'AHMAD',
        },
      ],
      'tgpay',
      0,
      ['gp365'],
    );
    expect(views[0].wallet).toBe('tron');
    expect(views[1]).not.toHaveProperty('wallet');
  });

  it('a wallet needs a valid address and no holder name; a bank is unchanged', () => {
    expect(
      withdrawalDetailsError({ bankCode: 'USDTTRC20', accountNumber: TRON }),
    ).toBeNull();
    expect(
      withdrawalDetailsError({ bankCode: 'USDTERC20', accountNumber: EVM }),
    ).toBeNull();
    expect(
      withdrawalDetailsError({ bankCode: 'USDTTRC20', accountNumber: EVM }),
    ).toMatch(/TRC20/);
    expect(
      withdrawalDetailsError({
        bankCode: 'USDTERC20',
        accountNumber: '12345678',
      }),
    ).toMatch(/ERC20/);
    expect(
      withdrawalDetailsError({ bankCode: 'MBBEMYKL', accountNumber: TRON }),
    ).toMatch(/digits only/);
    expect(
      withdrawalDetailsError({
        bankCode: 'MBBEMYKL',
        // Maybank accounts are 12 digits (#813), so only the name is missing.
        accountNumber: '123456789012',
      }),
    ).toMatch(/holder name/);
  });
});

describe('the shared adapter, bound to GlobePay365', () => {
  const config = a3payFamilyConfigFromEnv('gp365', GP365_ENV) as GatewayConfig;
  let sent: { path: string; data: Record<string, unknown> }[];

  beforeEach(() => {
    sent = [];
    global.fetch = jest.fn(async (url: string, init: { body: string }) => {
      const envelope = JSON.parse(init.body) as { Data: string };
      sent.push({
        path: new URL(url).pathname,
        data: JSON.parse(aesDecrypt(envelope.Data, 'gp-aes')),
      });
      const data = url.endsWith('/api/Payin/CreatePayin')
        ? {
            paymentOrderId: 'D1',
            paymentURL: 'https://cashier.globepay365.test/D1',
            payinActualAmount: 100.03,
          }
        : { paymentOrderId: 'W1' };
      return {
        status: 200,
        text: async () => JSON.stringify({ isSuccess: true, data }),
      };
    }) as unknown as typeof fetch;
  });

  const depositInput = (paymentMethodCode: string) => ({
    merchantTransactionId: 'PC-1',
    merchantClientId: 'cus_1',
    amount: 430,
    notifyUrl: 'https://us/hooks/gp365/deposit',
    returnUrl: 'https://us/return',
    ipAddress: '1.2.3.4',
    paymentMethodCode,
    gatewayAmount: 100,
  });

  it('creates a USDT payin with no payer name, on the chain the customer chose', async () => {
    const result = await submitDeposit(depositInput('UTRC'), config);
    expect(sent[0].path).toBe('/api/Payin/CreatePayin');
    expect(sent[0].data).toMatchObject({
      MID: 'GP00001',
      MCustId: 'cus_1',
      PayinAmount: '100.00',
      CurrCode: 'USDT',
      PaymentMethodId: 'UTRC',
    });
    expect(sent[0].data).not.toHaveProperty('FromCustomerAccountHolderName');
    expect(result).toMatchObject({
      transactionId: 'D1',
      url: 'https://cashier.globepay365.test/D1',
      depositActualAmount: 100.03,
    });
  });

  it("refuses A3Pay's SGD channels before any call", async () => {
    await expect(
      submitDeposit(depositInput('BQR'), config),
    ).rejects.toMatchObject({
      definite: true,
      codes: ['A3PAY_UNSUPPORTED_METHOD'],
    });
    expect(sent).toHaveLength(0);
  });

  // Production CreatePayin refuses ERC20 (2026-10-26): TRC20 is the only
  // USDT top-up chain until GlobePay365 opens it.
  it('offers TRC20 only, and refuses ERC20 before any call', async () => {
    expect(GATEWAYS.gp365.depositMethods).toEqual(['UTRC']);
    await expect(
      submitDeposit(depositInput('UERC'), config),
    ).rejects.toMatchObject({
      definite: true,
      codes: ['A3PAY_UNSUPPORTED_METHOD'],
    });
    expect(sent).toHaveLength(0);
  });

  it('pays a TRC20 wallet: network code, address, and MCustId as the holder', async () => {
    await submitWithdrawal(
      {
        merchantTransactionId: 'PC-2',
        merchantClientId: 'cus_1',
        amount: 430,
        destinationBankCode: 'USDTTRC20',
        destinationAccountNumber: TRON,
        destinationAccountHolderName: 'USDT · TRC20 (Tron)',
        notifyUrl: 'https://us/hooks/gp365/withdrawal',
        returnUrl: 'https://us/hooks/gp365/payout-verify',
        ipAddress: '1.2.3.4',
        gatewayAmount: 95.5,
      },
      config,
    );
    expect(sent[0].path).toBe('/api/Payout/SubmitPayout');
    expect(sent[0].data).toMatchObject({
      MCustId: 'cus_1',
      PayoutAmount: '95.50',
      CurrCode: 'USDT',
      ToClientBankCode: 'USDTTRC',
      ToClientAccountNumber: TRON,
      ToClientAccountHolderName: 'cus_1',
      PaymentMethodId: 'WD',
      ReturnClientURL: 'https://us/hooks/gp365/payout-verify',
    });
  });

  it('refuses a bank it cannot pay, definitely, before any call', async () => {
    await expect(
      submitWithdrawal(
        {
          merchantTransactionId: 'PC-3',
          merchantClientId: 'cus_1',
          amount: 430,
          destinationBankCode: 'DBSSSGSG',
          destinationAccountNumber: '1234567890',
          destinationAccountHolderName: 'Tan Ah Kow',
          notifyUrl: 'n',
          returnUrl: 'r',
          ipAddress: '1.2.3.4',
          gatewayAmount: 95.5,
        },
        config,
      ),
    ).rejects.toMatchObject({ definite: true, codes: ['A3PAY_UNKNOWN_BANK'] });
    expect(sent).toHaveLength(0);
  });
});

describe("GlobePay365's production payout cost and band (2026-10-21)", () => {
  it('reserves 0.2% plus the 1 USDT gas from our float; A3Pay keeps its 1.5%', () => {
    expect(payoutFloatNeeded('gp365', 60)).toBe(61.12); // 60.12 + 1
    expect(payoutFloatNeeded('gp365', 1000)).toBe(1003);
    expect(payoutFloatNeeded('a3pay', 100)).toBe(101.5);
  });

  it('pays out from 60 USDT, so the 2% withdrawal fee covers the gas', () => {
    expect(GATEWAYS.gp365.currencyLimits).toEqual({
      depositMin: 10,
      depositMax: 2000,
      withdrawalMin: 60,
      withdrawalMax: 5000,
    });
  });
});

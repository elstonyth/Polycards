import {
  ACTIVE_GATEWAY_TTL_MS,
  GATEWAYS,
  gatewayUrls,
  isPaymentGateway,
  paymentGateway,
  resolveActiveGateway,
  rowGatewayConfigs,
  setActiveGateway,
} from '../gateway';

const scopeWith = (setting: string | null | Error) => ({
  resolve: <T>(): T =>
    ({
      siteSettings: async () => {
        if (setting instanceof Error) throw setting;
        return { payment_gateway: setting };
      },
    }) as T,
});

afterEach(() => setActiveGateway(null));

describe('paymentGateway / setActiveGateway', () => {
  it('env decides until an admin setting is cached, then the setting wins', () => {
    expect(paymentGateway({})).toBe('globepay');
    expect(paymentGateway({ PAYMENT_GATEWAY: 'tgpay' })).toBe('tgpay');
    expect(paymentGateway({ PAYMENT_GATEWAY: 'bogus' })).toBe('globepay');
    setActiveGateway('tgpay');
    expect(paymentGateway({})).toBe('tgpay');
    setActiveGateway('globepay');
    expect(paymentGateway({ PAYMENT_GATEWAY: 'tgpay' })).toBe('globepay');
  });

  it('isPaymentGateway only accepts registered ids', () => {
    expect(isPaymentGateway('tgpay')).toBe(true);
    expect(isPaymentGateway('stripe')).toBe(false);
    expect(isPaymentGateway(null)).toBe(false);
    expect(isPaymentGateway('constructor')).toBe(false);
  });
});

describe('resolveActiveGateway', () => {
  it('reads the setting once per TTL, and a DB failure keeps the last value', async () => {
    const t0 = 1_000_000;
    expect(await resolveActiveGateway(scopeWith('tgpay'), t0)).toBe('tgpay');
    // Within the TTL the DB is not consulted, even if it changed.
    expect(await resolveActiveGateway(scopeWith('globepay'), t0 + 1000)).toBe(
      'tgpay',
    );
    // Past the TTL it is.
    expect(
      await resolveActiveGateway(
        scopeWith('globepay'),
        t0 + ACTIVE_GATEWAY_TTL_MS + 1,
      ),
    ).toBe('globepay');
    // A failing read never flips the gateway.
    expect(
      await resolveActiveGateway(
        scopeWith(new Error('db down')),
        t0 + 2 * ACTIVE_GATEWAY_TTL_MS + 2,
      ),
    ).toBe('globepay');
  });

  it('an unknown or null setting falls back to the env default', async () => {
    expect(await resolveActiveGateway(scopeWith('nope'), 5)).toBe(
      paymentGateway({}),
    );
    expect(
      await resolveActiveGateway(
        scopeWith(null),
        5 + ACTIVE_GATEWAY_TTL_MS + 1,
      ),
    ).toBe(paymentGateway({}));
  });
});

describe('gatewayUrls', () => {
  const explicit = {
    GLOBEPAY_NOTIFY_URL: 'https://old/notify',
    GLOBEPAY_RETURN_URL: 'https://shop/wallet',
    GLOBEPAY_WITHDRAW_NOTIFY_URL: 'https://old/wd',
    GLOBEPAY_PAYOUT_VERIFY_URL: 'https://old/verify',
  } as NodeJS.ProcessEnv;

  it('without PAYMENT_CALLBACK_BASE the explicit URLs apply unchanged', () => {
    expect(gatewayUrls('globepay', explicit)).toEqual({
      notifyUrl: 'https://old/notify',
      returnUrl: 'https://shop/wallet',
      withdrawNotifyUrl: 'https://old/wd',
      payoutVerifyUrl: 'https://old/verify',
      hasPayoutVerify: true,
    });
  });

  it('with PAYMENT_CALLBACK_BASE each gateway gets its own hook paths', () => {
    const env = { ...explicit, PAYMENT_CALLBACK_BASE: 'https://api.example/' };
    expect(gatewayUrls('tgpay', env)).toEqual({
      notifyUrl: 'https://api.example/hooks/tgpay/deposit',
      returnUrl: 'https://shop/wallet',
      withdrawNotifyUrl: 'https://api.example/hooks/tgpay/withdrawal',
      payoutVerifyUrl: '',
      hasPayoutVerify: false,
    });
    expect(gatewayUrls('globepay', env).payoutVerifyUrl).toBe(
      'https://api.example/hooks/globepay/payout-verify',
    );
  });

  it('missing values come back empty so callers fail closed', () => {
    expect(gatewayUrls('tgpay', {} as NodeJS.ProcessEnv).notifyUrl).toBe('');
  });
});

describe('rowGatewayConfigs', () => {
  it('returns a config per row gateway, null for unknown or unconfigured ones, memoised', () => {
    const env = {
      TGPAY_API_BASE: 'https://sandbox-api.x/api/v2',
      TGPAY_PUBLIC_KEY: 'pk',
      TGPAY_SECRET_KEY: 'sk',
    } as NodeJS.ProcessEnv;
    const configFor = rowGatewayConfigs(env);
    expect(configFor('tgpay')).toMatchObject({ kind: 'tgpay' });
    expect(configFor('tgpay')).toBe(configFor('tgpay'));
    expect(configFor('globepay')).toBeNull(); // no GLOBEPAY_* in env
    expect(configFor('stripe')).toBeNull();
  });

  it('every registered gateway declares its hooks and a configured() probe', () => {
    for (const def of Object.values(GATEWAYS)) {
      expect(def.hooks.deposit).toMatch(/^\/hooks\//);
      expect(def.hooks.withdrawal).toMatch(/^\/hooks\//);
      expect(def.configured({} as NodeJS.ProcessEnv)).toBe(false);
    }
  });
});

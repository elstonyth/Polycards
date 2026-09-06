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

const scopeWith = (setting: string | null | Error) => {
  const siteSettings = jest.fn(async () => {
    if (setting instanceof Error) throw setting;
    return { payment_gateway: setting };
  });
  return {
    siteSettings,
    resolve: <T>(): T => ({ siteSettings }) as T,
  };
};

afterEach(() => setActiveGateway(null));

describe('paymentGateway / setActiveGateway', () => {
  it('env decides until an admin setting is cached, then the setting wins', () => {
    expect(paymentGateway({})).toBe('tgpay');
    expect(paymentGateway({ PAYMENT_GATEWAY: 'tgpay' })).toBe('tgpay');
    // A retired or unknown value falls back to the default, never throws.
    expect(paymentGateway({ PAYMENT_GATEWAY: 'globepay' })).toBe('tgpay');
    expect(paymentGateway({ PAYMENT_GATEWAY: 'bogus' })).toBe('tgpay');
    setActiveGateway('tgpay');
    expect(paymentGateway({ PAYMENT_GATEWAY: 'bogus' })).toBe('tgpay');
  });

  it('isPaymentGateway only accepts registered ids', () => {
    expect(isPaymentGateway('tgpay')).toBe(true);
    expect(isPaymentGateway('globepay')).toBe(false);
    expect(isPaymentGateway('stripe')).toBe(false);
    expect(isPaymentGateway(null)).toBe(false);
    expect(isPaymentGateway('constructor')).toBe(false);
  });
});

describe('resolveActiveGateway', () => {
  it('reads the setting once per TTL, and a DB failure keeps the last value', async () => {
    const t0 = 1_000_000;
    expect(await resolveActiveGateway(scopeWith('tgpay'), t0)).toBe('tgpay');
    // Within the TTL the DB is not consulted at all.
    const inside = scopeWith('tgpay');
    expect(await resolveActiveGateway(inside, t0 + 1000)).toBe('tgpay');
    expect(inside.siteSettings).not.toHaveBeenCalled();
    // Past the TTL it is.
    const past = scopeWith('tgpay');
    expect(
      await resolveActiveGateway(past, t0 + ACTIVE_GATEWAY_TTL_MS + 1),
    ).toBe('tgpay');
    expect(past.siteSettings).toHaveBeenCalledTimes(1);
    // A failing read never flips the gateway (nor throws).
    expect(
      await resolveActiveGateway(
        scopeWith(new Error('db down')),
        t0 + 2 * ACTIVE_GATEWAY_TTL_MS + 2,
      ),
    ).toBe('tgpay');
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
  it('with PAYMENT_CALLBACK_BASE the gateway gets its own hook paths; the return URL reads either name', () => {
    const env = {
      PAYMENT_CALLBACK_BASE: 'https://api.example/',
      GLOBEPAY_RETURN_URL: 'https://shop/wallet',
    } as NodeJS.ProcessEnv;
    expect(gatewayUrls('tgpay', env)).toEqual({
      notifyUrl: 'https://api.example/hooks/tgpay/deposit',
      returnUrl: 'https://shop/wallet',
      withdrawNotifyUrl: 'https://api.example/hooks/tgpay/withdrawal',
      payoutVerifyUrl: '',
      hasPayoutVerify: false,
    });
    expect(
      gatewayUrls('tgpay', {
        ...env,
        PAYMENT_RETURN_URL: 'https://shop/transactions',
      }).returnUrl,
    ).toBe('https://shop/transactions');
  });

  it('without PAYMENT_CALLBACK_BASE every hook URL is empty so callers fail closed — no legacy explicit URL is honoured', () => {
    const urls = gatewayUrls('tgpay', {
      GLOBEPAY_NOTIFY_URL: 'https://old/hooks/globepay/deposit',
    } as NodeJS.ProcessEnv);
    expect(urls.notifyUrl).toBe('');
    expect(urls.withdrawNotifyUrl).toBe('');
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

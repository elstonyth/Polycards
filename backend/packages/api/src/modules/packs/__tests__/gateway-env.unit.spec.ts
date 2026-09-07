import {
  gatewayEnv,
  gatewayEnvName,
  legacyGatewayEnvNames,
  warnLegacyGatewayEnv,
} from '../gateway-env';

// The legacy GLOBEPAY_* spellings live in exactly one place (gateway-env.ts);
// this spec is the only other file allowed to name them.

describe('gatewayEnv', () => {
  it('reads the current name first, the legacy name second, else undefined', () => {
    expect(gatewayEnv('GATEWAY_ENABLED', {})).toBeUndefined();
    expect(gatewayEnv('GATEWAY_ENABLED', { GLOBEPAY_ENABLED: 'true' })).toBe(
      'true',
    );
    expect(
      gatewayEnv('GATEWAY_ENABLED', {
        GATEWAY_ENABLED: 'false',
        GLOBEPAY_ENABLED: 'true',
      }),
    ).toBe('false');
    expect(
      gatewayEnv('PAYMENT_RETURN_URL', { GLOBEPAY_RETURN_URL: 'https://x' }),
    ).toBe('https://x');
  });

  it('gatewayEnvName hands back whichever name is set, the current one winning', () => {
    expect(gatewayEnvName('GATEWAY_WD_DAILY_MAX_RM', {})).toBe(
      'GLOBEPAY_WD_DAILY_MAX_RM',
    );
    expect(
      gatewayEnvName('GATEWAY_WD_DAILY_MAX_RM', {
        GLOBEPAY_WD_DAILY_MAX_RM: '1',
      }),
    ).toBe('GLOBEPAY_WD_DAILY_MAX_RM');
    expect(
      gatewayEnvName('GATEWAY_WD_DAILY_MAX_RM', {
        GATEWAY_WD_DAILY_MAX_RM: '2',
        GLOBEPAY_WD_DAILY_MAX_RM: '1',
      }),
    ).toBe('GATEWAY_WD_DAILY_MAX_RM');
  });
});

describe('warnLegacyGatewayEnv', () => {
  it('warns ONCE, naming every legacy variable still set, and returns them', () => {
    const warn = jest.fn();
    const env = {
      GLOBEPAY_ENABLED: 'true',
      GLOBEPAY_WD_APPROVAL_ABOVE_RM: '0',
      GATEWAY_WITHDRAWALS_ENABLED: 'true',
    };
    expect(legacyGatewayEnvNames(env)).toEqual([
      'GLOBEPAY_ENABLED',
      'GLOBEPAY_WD_APPROVAL_ABOVE_RM',
    ]);
    expect(warnLegacyGatewayEnv(env, warn)).toEqual([
      'GLOBEPAY_ENABLED',
      'GLOBEPAY_WD_APPROVAL_ABOVE_RM',
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    const [message] = warn.mock.calls[0] as [string];
    expect(message).toContain('GLOBEPAY_ENABLED (read as GATEWAY_ENABLED)');
    expect(message).toContain(
      'GLOBEPAY_WD_APPROVAL_ABOVE_RM (read as GATEWAY_WD_APPROVAL_ABOVE_RM)',
    );
    expect(message).not.toContain('GATEWAY_WITHDRAWALS_ENABLED');
  });

  it('stays silent when only the current names are set', () => {
    const warn = jest.fn();
    expect(warnLegacyGatewayEnv({ GATEWAY_ENABLED: 'true' }, warn)).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });
});

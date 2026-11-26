import { describe, expect, it } from 'vitest';
import { hostnameOf, isPrivateHost, secureCookieFor } from '../private-host';

describe('a private host', () => {
  it('is this machine, a private network, the tailnet, or a bare local name', () => {
    for (const h of [
      'localhost',
      'preview.localhost',
      '127.0.0.1',
      '[::1]',
      '10.1.2.3',
      '192.168.50.203',
      '172.16.0.1',
      '172.31.255.1',
      '100.123.197.93', // Tailscale
      'd3-work.tail133bd2.ts.net',
      'd3-work', // MagicDNS short name
    ])
      expect(isPrivateHost(h), h).toBe(true);
  });

  it('is never a public site', () => {
    for (const h of [
      'polycards.gg',
      'www.polycards.gg',
      'admin.polycards.gg',
      'polycards-storefront.ondigitalocean.app',
      '8.8.8.8',
      '172.32.0.1',
      '100.128.0.1',
      '',
    ])
      expect(isPrivateHost(h), h).toBe(false);
  });

  it('reads the name out of a Host header', () => {
    expect(hostnameOf('192.168.50.203:4320')).toBe('192.168.50.203');
    expect(hostnameOf('polycards.gg')).toBe('polycards.gg');
    expect(hostnameOf('[::1]:4320')).toBe('[::1]');
  });
});

describe('when a cookie is marked Secure', () => {
  it('always on the live site, whatever the request says', () => {
    expect(
      secureCookieFor({ prod: true, proto: 'https', host: 'polycards.gg' }),
    ).toBe(true);
    expect(
      secureCookieFor({ prod: true, proto: null, host: 'polycards.gg' }),
    ).toBe(true);
    expect(
      secureCookieFor({ prod: true, proto: 'http', host: 'polycards.gg' }),
    ).toBe(true);
  });

  it('on any https request', () => {
    expect(
      secureCookieFor({
        prod: true,
        proto: 'https',
        host: '192.168.50.203:4320',
      }),
    ).toBe(true);
  });

  it('not for a production build served over plain http on this machine, its network or the tailnet', () => {
    for (const host of [
      '192.168.50.203:4320',
      '100.123.197.93:4320',
      'd3-work.tail133bd2.ts.net:4320',
      'localhost:4320',
    ])
      expect(secureCookieFor({ prod: true, proto: null, host }), host).toBe(
        false,
      );
  });

  it('not in development', () => {
    expect(
      secureCookieFor({ prod: false, proto: 'https', host: 'polycards.gg' }),
    ).toBe(false);
  });
});

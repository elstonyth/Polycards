import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  localSignInConfig,
  localTokenValid,
  safeNextPath,
  signLocalToken,
} from '../local-sign-in';

const OK_ENV = {
  LOCAL_SIGN_IN: '1',
  LOCAL_SIGN_IN_SECRET: 'local-prod-copy-jwt-not-for-prod',
  LOCAL_SIGN_IN_ACCOUNTS: 'cus_A:authid_A,cus_B:authid_B',
  NEXT_PUBLIC_MEDUSA_BACKEND_URL: 'http://localhost:9100',
};

describe('when local sign-in is on', () => {
  it('is on only with the switch, a secret, accounts and a local backend', () => {
    const cfg = localSignInConfig(OK_ENV);
    expect(cfg?.accounts).toEqual([
      { customerId: 'cus_A', authIdentityId: 'authid_A' },
      { customerId: 'cus_B', authIdentityId: 'authid_B' },
    ]);
  });

  it('is off without the switch, the secret or any account', () => {
    expect(
      localSignInConfig({ ...OK_ENV, LOCAL_SIGN_IN: undefined }),
    ).toBeNull();
    expect(localSignInConfig({ ...OK_ENV, LOCAL_SIGN_IN: 'true' })).toBeNull();
    expect(
      localSignInConfig({ ...OK_ENV, LOCAL_SIGN_IN_SECRET: '' }),
    ).toBeNull();
    expect(
      localSignInConfig({ ...OK_ENV, LOCAL_SIGN_IN_ACCOUNTS: '' }),
    ).toBeNull();
    expect(
      localSignInConfig({ ...OK_ENV, LOCAL_SIGN_IN_ACCOUNTS: 'cus_A' }),
    ).toBeNull();
  });

  it('is off whenever the backend is not on this machine or its network', () => {
    for (const url of [
      'https://admin.polycards.gg',
      'https://api.example.com',
      'http://8.8.8.8:9000',
      'not a url',
    ])
      expect(
        localSignInConfig({ ...OK_ENV, NEXT_PUBLIC_MEDUSA_BACKEND_URL: url }),
      ).toBeNull();
    // unset means the SDK's default, local :9000
    expect(
      localSignInConfig({
        ...OK_ENV,
        NEXT_PUBLIC_MEDUSA_BACKEND_URL: undefined,
      }),
    ).not.toBeNull();
    for (const url of [
      'http://127.0.0.1:9100',
      'http://192.168.50.203:9100',
      'http://10.0.0.5:9100',
    ])
      expect(
        localSignInConfig({ ...OK_ENV, NEXT_PUBLIC_MEDUSA_BACKEND_URL: url }),
      ).not.toBeNull();
  });
});

describe('the token it signs', () => {
  const account = { customerId: 'cus_A', authIdentityId: 'authid_A' };
  const token = signLocalToken('s3cret', account, 1_700_000_000);
  const [head, body, sig] = token.split('.');

  it('is an HS256 JWT signed with the secret', () => {
    expect(JSON.parse(Buffer.from(head ?? '', 'base64url').toString())).toEqual(
      {
        alg: 'HS256',
        typ: 'JWT',
      },
    );
    const want = createHmac('sha256', 's3cret')
      .update(`${head}.${body}`)
      .digest('base64url');
    expect(sig).toBe(want);
  });

  it('carries the claims the backend reads, and expires in a day', () => {
    const claims = JSON.parse(Buffer.from(body ?? '', 'base64url').toString());
    expect(claims).toMatchObject({
      actor_id: 'cus_A',
      actor_type: 'customer',
      auth_identity_id: 'authid_A',
      app_metadata: { customer_id: 'cus_A' },
      iat: 1_700_000_000,
      exp: 1_700_000_000 + 86_400,
    });
  });
});

describe('where it sends you after', () => {
  it('keeps a path on this site and refuses anything else', () => {
    expect(safeNextPath('/vault')).toBe('/vault');
    expect(safeNextPath(null)).toBe('/me');
    expect(safeNextPath('https://evil.example')).toBe('/me');
    expect(safeNextPath('//evil.example')).toBe('/me');
    expect(safeNextPath('/\\evil.example')).toBe('/me');
    // a browser drops tabs and line breaks, so these read as //evil.example
    for (const gap of ['\t', '\n', '\r']) {
      const sneaky = `/${gap}/evil.example`;
      expect(new URL(sneaky, 'http://localhost:4320').host).toBe(
        'evil.example',
      );
      expect(safeNextPath(sneaky)).toBe('/me');
    }
    expect(safeNextPath('/vault?tab=history')).toBe('/vault?tab=history');
  });
});

describe('a session the local preview keeps', () => {
  const account = { customerId: 'cus_A', authIdentityId: 'authid_A' };
  const now = 1_700_000_000;
  const token = signLocalToken('s3cret', account, now);

  it('is one this machine signed, with more than an hour left', () => {
    expect(localTokenValid('s3cret', token, now)).toBe(true);
    expect(localTokenValid('s3cret', token, now + 86_400 - 3_601)).toBe(true);
  });

  it('is replaced in its last hour, once expired, or when signed by anyone else', () => {
    expect(localTokenValid('s3cret', token, now + 86_400 - 3_600)).toBe(false);
    expect(localTokenValid('s3cret', token, now + 90_000)).toBe(false);
    expect(localTokenValid('another-secret', token, now)).toBe(false);
    const [head, , sig] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify({ actor_id: 'cus_X', exp: now + 86_400 }),
    ).toString('base64url');
    expect(localTokenValid('s3cret', `${head}.${forged}.${sig}`, now)).toBe(
      false,
    );
    for (const junk of ['', 'abc', 'a.b', 'a.b.c.d', `${token}x`])
      expect(localTokenValid('s3cret', junk, now), junk).toBe(false);
  });
});

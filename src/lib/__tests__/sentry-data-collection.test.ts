import { describe, expect, it } from 'vitest';
import { sentryDataCollection } from '../sentry-data-collection';

// @sentry/* 11 collects user info, cookies, HTTP bodies and local variables
// unless told not to. Each of those can carry a session, an OTP or a bank
// detail, so turning one back on should be a deliberate edit of this test.

describe('sentryDataCollection', () => {
  it('keeps every personal-data switch off', () => {
    expect(sentryDataCollection).toMatchObject({
      userInfo: false,
      cookies: false,
      httpBodies: [],
      urlQueryParams: false,
      stackFrameVariables: false,
      databaseQueryData: false,
      queues: false,
      httpHeaders: { response: false },
      graphQL: { variables: false },
      genAI: { inputs: false, outputs: false },
    });
  });

  // Error events drop client-IP headers on their own, but server spans copy
  // every request header into http.request.header.* attributes. Behind
  // Cloudflare these carry the real visitor IP. The deny terms match by
  // substring, and must cover every header Sentry itself treats as an IP
  // source (@sentry/core vendor/getIpAddress.js, 11.4).
  it.each([
    'X-Client-IP',
    'X-Forwarded-For',
    'Fly-Client-IP',
    'CF-Connecting-IP',
    'Fastly-Client-Ip',
    'True-Client-Ip',
    'X-Real-IP',
    'X-Cluster-Client-IP',
    'X-Forwarded',
    'Forwarded-For',
    'Forwarded',
    'X-Vercel-Forwarded-For',
  ])('filters the %s request header', (header) => {
    const request = (
      sentryDataCollection?.httpHeaders as { request: { deny: string[] } }
    ).request;
    expect(
      request.deny.some((term) => header.toLowerCase().includes(term)),
    ).toBe(true);
  });
});

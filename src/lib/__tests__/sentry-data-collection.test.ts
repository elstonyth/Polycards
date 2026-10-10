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
});

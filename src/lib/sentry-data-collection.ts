import type * as Sentry from '@sentry/nextjs';

type SentryInitOptions = NonNullable<Parameters<typeof Sentry.init>[0]>;

/**
 * Sentry `dataCollection` for every runtime (browser, server, edge).
 *
 * @sentry/* 11 replaced `sendDefaultPii` with this option and switched most of
 * it ON by default: user info, cookies, request and response bodies,
 * stack-frame local variables and database query data. This site carries
 * logins, OTPs, deposits and bank details, so everything that 10.x did not
 * send (with `sendDefaultPii` unset) is switched back off here.
 *
 * Request headers stay, as they did on 10.x; Sentry masks any header whose
 * name contains auth/token/session/cookie/key. The query string goes, for the
 * same reason `scrubBreadcrumbUrls` strips it from breadcrumbs: an emailed
 * reset link carries its single-use token there, and the Google return leg its
 * code and state.
 */
export const sentryDataCollection: SentryInitOptions['dataCollection'] = {
  userInfo: false,
  cookies: false,
  httpHeaders: { request: true, response: false },
  httpBodies: [],
  urlQueryParams: false,
  stackFrameVariables: false,
  databaseQueryData: false,
  queues: false,
  graphQL: { document: true, variables: false },
  genAI: { inputs: false, outputs: false },
};

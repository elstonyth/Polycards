import * as Sentry from '@sentry/nextjs';
import { scrubBreadcrumbUrls, scrubSpanUrls } from './sentry-breadcrumbs';
import { sentryDataCollection } from './sentry-data-collection';

// Loaded on demand, only by builds with a DSN: see instrumentation-client.ts.
Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: 0.1,
  enabled: Boolean(process.env.NEXT_PUBLIC_SENTRY_DSN),
  beforeBreadcrumb: scrubBreadcrumbUrls,
  beforeSendSpan: scrubSpanUrls,
  dataCollection: sentryDataCollection,
  // A page transition skipped because the DOM update ran past Chrome's limit:
  // the page still changes, only the animation drops. React reports it anyway.
  ignoreErrors: [/Transition was aborted because of timeout in DOM update/],
});

export const { captureException, captureRouterTransitionStart } = Sentry;

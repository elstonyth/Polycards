import * as Sentry from '@sentry/nextjs';
import {
  scrubBreadcrumbUrls,
  scrubSpanUrls,
} from './src/lib/sentry-breadcrumbs';
import { sentryDataCollection } from './src/lib/sentry-data-collection';
import { installTranslateDomGuard } from './src/lib/translate-dom-guard';

// Synchronous and top-level, so it is in place before hydration.
installTranslateDomGuard();

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

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;

import * as Sentry from '@sentry/nextjs';
import { scrubBreadcrumbUrls } from './src/lib/sentry-breadcrumbs';
import { sentryDataCollection } from './src/lib/sentry-data-collection';

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: 0.1,
  enabled: Boolean(process.env.NEXT_PUBLIC_SENTRY_DSN),
  beforeBreadcrumb: scrubBreadcrumbUrls,
  dataCollection: sentryDataCollection,
});

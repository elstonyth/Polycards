import type { captureRouterTransitionStart } from '@sentry/nextjs';
import { installTranslateDomGuard } from './src/lib/translate-dom-guard';

// Synchronous and top-level, so it is in place before hydration.
installTranslateDomGuard();

// No DSN, no SDK: the browser SDK is ~125 KB of parsed JS on every route, and it
// would only run with `enabled: false` (same rule as src/instrumentation.ts).
// shortcut: with a DSN the SDK initialises when its chunk arrives, so an error
// thrown before that is not reported. Move the init back to the top level if
// Sentry goes live and those early errors matter.
const sdk = process.env.NEXT_PUBLIC_SENTRY_DSN
  ? import('./src/lib/sentry-client')
  : null;

export const onRouterTransitionStart = (
  ...args: Parameters<typeof captureRouterTransitionStart>
) => {
  void sdk?.then((sentry) => sentry.captureRouterTransitionStart(...args));
};

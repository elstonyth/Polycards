import type { ReactNode } from 'react';

// Page transitions are OFF (2026-10-25). They were React <ViewTransition>
// wrappers mounted by the route templates, so every navigation started a view
// transition. WebKit keeps each transition's snapshots in its GPU process and
// never frees them: ~70 MB per navigation in an iPhone-emulated WebKit run (18
// navigations: 1.3 GB vs 97 MB without), and iOS Safari kills the tab — "This
// web page was reloaded because a problem occurred", including mid-reveal.
// Both exports stay so the templates and loading.tsx fallbacks keep their
// shape; the CSS in globals.css ("Page transitions") is inert without them.
// Re-enable only with a WebKit memory check across many navigations.
export function PageTransition({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

/** For loading.tsx fallbacks (formerly faded the skeleton out over the page). */
export function SkeletonExit({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

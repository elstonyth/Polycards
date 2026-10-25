import { ViewTransition, type ReactNode } from 'react';

// Every page change animates (operator 2026-10-25: "every navigation must be
// smooth"). Mounted by the route templates, which remount per navigation, so
// the old page exits and the new one enters; the header and tab bar live in
// the layout and stay still. Types come from <Link transitionTypes>: entering
// a game zooms in, leaving one zooms out, everything else fades and rises.
// The CSS is in globals.css ("Page transitions"). Browsers without view
// transitions just swap pages.
const ANIMATION = {
  'game-in': 'game-in',
  'game-out': 'game-out',
  default: 'page',
};

export function PageTransition({ children }: { children: ReactNode }) {
  return (
    <ViewTransition enter={ANIMATION} exit={ANIMATION} default="none">
      {children}
    </ViewTransition>
  );
}

/** For loading.tsx fallbacks: the skeleton fades out over the page as it
 *  arrives, instead of the page snapping in. */
export function SkeletonExit({ children }: { children: ReactNode }) {
  return (
    <ViewTransition exit="skeleton" default="none">
      {children}
    </ViewTransition>
  );
}

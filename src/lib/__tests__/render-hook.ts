// Shared jsdom harness for the hook suites (use-live-poll, use-recent-pulls,
// use-pack-detail-poll). No @testing-library/react lives in this repo — these
// hooks' rules are all ACROSS-render behaviour (a changing scope prop, a second
// tick landing on the first one's write), which a pure-logic extraction cannot
// observe, so drive React directly via createRoot + act instead of adding a
// dependency. react-dom + jsdom are already installed.
//
// Not a *.test.ts file on purpose: vitest collects `src/**/*.test.ts` only
// (see vitest.config.ts), the same way store-shim.ts sits here.
import { createElement, act, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/** Render a hook and capture its result. The result is captured in a layout
 *  effect (not during render) so it stays a side effect, not a render
 *  impurity — act() flushes layout effects synchronously, so it is readable
 *  immediately after render/rerender. */
export function renderHook<P, T>(useHook: (props: P) => T, initialProps: P) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const box: { current: T } = { current: undefined as unknown as T };
  let root!: Root;
  function Probe({ props }: { props: P }) {
    const result = useHook(props);
    useLayoutEffect(() => {
      box.current = result;
    });
    return null;
  }
  act(() => {
    root = createRoot(container);
    root.render(createElement(Probe, { props: initialProps }));
  });
  return {
    get current() {
      return box.current;
    },
    /** Omit `props` when the hook closes over a mutable fixture instead. */
    rerender: (props: P = initialProps) => {
      act(() => {
        root.render(createElement(Probe, { props }));
      });
    },
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

/** Flush pending promises (and the state updates they cause) through React. */
export const flush = () => act(async () => {});

// jsdom's default document.visibilityState is "prerender", not "visible" — a
// visibility-gated tick would silently no-op in every test without this.
let visibility: DocumentVisibilityState = 'visible';
Object.defineProperty(document, 'visibilityState', {
  configurable: true,
  get: () => visibility,
});

/** Set the tab's visibility and fire `visibilitychange`, exactly as a browser
 *  does when a backgrounded tab is refocused. */
export function setVisibility(next: DocumentVisibilityState): void {
  visibility = next;
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

/** Set the tab's visibility WITHOUT firing the event — for a hook that mounts
 *  into an already-hidden tab. */
export function presetVisibility(next: DocumentVisibilityState): void {
  visibility = next;
}

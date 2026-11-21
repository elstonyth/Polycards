'use client';

import {
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from 'react';
import type { RecentFeed } from '@/lib/data/packs';

type DrawerProps = { initial: RecentFeed; initialTab?: string };

/** How long to wait for the flow to come on before measuring anyway. */
const FLOW_WAIT_MS = 6000;

const controls = (el: HTMLElement): HTMLElement[] => [
  ...el.querySelectorAll<HTMLElement>('a[href], button'),
];

/** One fetch of the drawer's chunk at a time; a failed one may be tried again. */
let drawerLoad: Promise<ComponentType<DrawerProps>> | null = null;
function loadDrawer(): Promise<ComponentType<DrawerProps>> {
  drawerLoad ??= import(
    /* webpackChunkName: "jp-drawer" */ './JustPulledDrawer'
  ).then(
    (m) => m.JustPulledDrawer,
    (e: unknown) => {
      drawerLoad = null;
      throw e;
    },
  );
  return drawerLoad;
}

/**
 * Calls onNear once the section comes within a screen and a half of the
 * viewport, in the layout the visitor gets. Not before the page has loaded,
 * nor while the flow is off: its spacers have no height then, which puts
 * this section within reach of the row. That holds before the flow comes on
 * and when it drops out for a while (the focused view's chunk is late) and
 * comes back. Without the flow (reduced motion, no flow root, or the flow off
 * for FLOW_WAIT_MS straight) the plain page is measured as it is. Returns
 * the cleanup.
 */
export function watchNear(el: HTMLElement, onNear: () => void): () => void {
  const root = el.closest('[data-home-flow]');
  let loaded = false;
  let done = false;
  /** The flow has been off for FLOW_WAIT_MS straight: it is not coming. */
  let waited = false;
  let wait: ReturnType<typeof setTimeout> | undefined;
  const plain = () =>
    !root ||
    waited ||
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const trusted = () => plain() || !!root?.hasAttribute('data-flow-on');
  const io = new IntersectionObserver(
    (entries) => {
      if (done || !trusted() || !entries.some((e) => e.isIntersecting)) return;
      done = true;
      stop();
      onNear();
    },
    { rootMargin: '150% 0px' },
  );
  /** Watches only while the layout can be trusted; observing again gives a
   *  fresh measurement of the layout now on the page. */
  const measure = () => {
    if (!loaded || done) return;
    io.unobserve(el);
    if (trusted()) io.observe(el);
  };
  /** Each time the flow goes off (or is not on yet) the wait starts over. */
  const restartWait = () => {
    clearTimeout(wait);
    waited = false;
    if (trusted()) return;
    wait = setTimeout(() => {
      waited = true;
      measure();
    }, FLOW_WAIT_MS);
  };
  const watch = root
    ? new MutationObserver(() => {
        restartWait();
        measure();
      })
    : null;
  if (root)
    watch?.observe(root, {
      attributes: true,
      attributeFilter: ['data-flow-on'],
    });
  const afterLoad = () => {
    loaded = true;
    restartWait();
    measure();
  };
  function stop() {
    io.disconnect();
    window.removeEventListener('load', afterLoad);
    watch?.disconnect();
    clearTimeout(wait);
  }
  if (document.readyState === 'complete') afterLoad();
  else window.addEventListener('load', afterLoad, { once: true });
  return () => {
    done = true;
    stop();
  };
}

/**
 * Just Pulled's only first-load code: it shows the server's markup (the
 * drawer at rest, already complete) and fetches the live drawer's chunk when
 * the section comes within a screen and a half of the viewport, or on a first
 * press or focus inside it. The live drawer then renders the same markup in
 * its place, so the swap moves nothing.
 */
export function JustPulledShell({
  initial,
  children,
}: {
  initial: RecentFeed;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  /** A tab pressed before the drawer arrived: the drawer opens on it. */
  const [pressed, setPressed] = useState<string | undefined>(undefined);
  /** The control that had focus at the swap, by its place in the section. */
  const focusAt = useRef(-1);
  const [Drawer, setDrawer] = useState<ComponentType<DrawerProps> | null>(null);

  useEffect(() => {
    const host = ref.current;
    if (!host) return;
    const el: HTMLDivElement = host;
    let asked = false;
    let alive = true;
    function want() {
      if (asked) return;
      asked = true;
      stopWatch();
      loadDrawer().then(
        (D) => {
          if (!alive) return;
          const f = document.activeElement;
          focusAt.current =
            f instanceof HTMLElement && el.contains(f)
              ? controls(el).indexOf(f)
              : -1;
          setDrawer(() => D);
        },
        () => {
          asked = false; // the next press or focus tries again
        },
      );
    }
    const stopWatch = watchNear(el, want);
    el.addEventListener('pointerdown', want);
    el.addEventListener('focusin', want);
    return () => {
      alive = false;
      stopWatch();
      el.removeEventListener('pointerdown', want);
      el.removeEventListener('focusin', want);
    };
  }, []);

  // The swap replaces the server's markup: focus goes back to the same
  // control in the drawer's.
  useEffect(() => {
    const el = ref.current;
    if (!Drawer || !el || focusAt.current < 0) return;
    controls(el)[focusAt.current]?.focus({ preventScroll: true });
    focusAt.current = -1;
  }, [Drawer]);

  return (
    <div
      ref={ref}
      data-jp=""
      data-jp-live={Drawer ? '1' : undefined}
      onClickCapture={
        Drawer
          ? undefined
          : (e) => {
              const b = (e.target as Element).closest('button[aria-pressed]');
              if (b)
                setPressed(
                  (b.getAttribute('aria-label') ?? b.textContent ?? '').trim(),
                );
            }
      }
    >
      {Drawer ? <Drawer initial={initial} initialTab={pressed} /> : children}
    </div>
  );
}

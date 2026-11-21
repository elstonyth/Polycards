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
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) want();
      },
      { rootMargin: '150% 0px' },
    );
    function want() {
      if (asked) return;
      asked = true;
      io.disconnect();
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
    // Not before the page has loaded, nor while the flow is still laying
    // out the page (its spacers have no height until it is on, which puts
    // this section within reach of the row). Without the flow (reduced
    // motion, or it never comes on) the plain page is measured as it is.
    const root = el.closest('[data-home-flow]');
    const flowOn = () => !root || root.hasAttribute('data-flow-on');
    let started = false;
    let watch: MutationObserver | null = null;
    let fallback: ReturnType<typeof setTimeout> | undefined;
    const start = () => {
      if (started) return;
      started = true;
      watch?.disconnect();
      clearTimeout(fallback);
      io.observe(el);
    };
    const afterLoad = () => {
      if (
        !root ||
        flowOn() ||
        window.matchMedia('(prefers-reduced-motion: reduce)').matches
      )
        return start();
      watch = new MutationObserver(() => {
        if (flowOn()) start();
      });
      watch.observe(root, {
        attributes: true,
        attributeFilter: ['data-flow-on'],
      });
      fallback = setTimeout(start, FLOW_WAIT_MS);
    };
    if (document.readyState === 'complete') afterLoad();
    else window.addEventListener('load', afterLoad, { once: true });
    el.addEventListener('pointerdown', want);
    el.addEventListener('focusin', want);
    return () => {
      alive = false;
      io.disconnect();
      window.removeEventListener('load', afterLoad);
      watch?.disconnect();
      clearTimeout(fallback);
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

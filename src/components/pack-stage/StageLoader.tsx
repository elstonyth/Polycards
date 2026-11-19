'use client';

import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentType,
} from 'react';
import type { BrandLoaderProps } from '@/components/loader/BrandLoader';
import { useStage3d } from './Stage3dProvider';
import {
  HOME_LOADER_MAX_MS,
  LOADER_LATE_AT_MS,
  STAGE_LOADER_ATTR,
  loaderMaxMs,
} from './stage-loader-script';
import styles from './pack-stage.module.css';

function subscribe(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: [STAGE_LOADER_ATTR],
  });
  return () => observer.disconnect();
}

const loaderUp = () => document.documentElement.hasAttribute(STAGE_LOADER_ATTR);

/**
 * Whether this document load is showing the stage loader: the inline
 * pre-paint script set `html[data-stage-loader]`. `serverValue` is what the
 * server render (and so hydration) assumes.
 */
export function useStageLoaderUp(serverValue: boolean): boolean {
  return useSyncExternalStore(subscribe, loaderUp, () => serverValue);
}

const dropAttr = () =>
  document.documentElement.removeAttribute(STAGE_LOADER_ATTR);

/** Past this (from navigation start) the attribute goes whatever happened:
 *  the cap, the exit fade and a margin. Never an inert page for good. */
const GIVE_UP_MS = HOME_LOADER_MAX_MS + 1500;

type Loaded = { Loader: ComponentType<BrandLoaderProps>; maxMs: number };

/**
 * The stage's brand loader (plan section 6). The shell is in every server
 * render, shown by CSS only under `html[data-stage-loader]`, and paints what
 * BrandLoader paints at clock 0: the ink cover. On hydration it unmounts at
 * once when that attribute is absent (a returning or reduced-motion visitor).
 * It never claims the first visit itself: the inline script already did.
 *
 * BrandLoader itself (and the motion components it animates with) is loaded
 * only on a first visit, after hydration, so a returning visitor never
 * downloads it. It leaves when the 3D stage is ready (or settled flat, then at
 * its minimum), and at the latest HOME_LOADER_MAX_MS after navigation start:
 * `maxMs` is taken when it mounts, since it times from its own mount.
 * `onLeave` fires as its exit fade starts; finishing, failing to load or
 * unmounting drops the html attribute.
 */
export default function StageLoader({ onLeave }: { onLeave?: () => void }) {
  const up = useStageLoaderUp(true);
  const stage3d = useStage3d();
  const ready = stage3d.ready || stage3d.mode === 'flat';
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const onLeaveRef = useRef(onLeave);
  useEffect(() => {
    onLeaveRef.current = onLeave;
  }, [onLeave]);

  useEffect(() => dropAttr, []);

  useEffect(() => {
    if (!up) return;
    // Hydrated too late for any reveal (a slow device or network; the CSS
    // failsafe has shown the page by now): just let go, no loader download.
    if (performance.now() > LOADER_LATE_AT_MS) {
      dropAttr();
      return;
    }
    let live = true;
    import('@/components/loader/BrandLoader').then(
      (m) => {
        if (!live) return;
        const now = performance.now();
        // Too late for a reveal inside the cap: hand straight over to the page.
        if (now > LOADER_LATE_AT_MS) {
          onLeaveRef.current?.();
          dropAttr();
          return;
        }
        setLoaded({ Loader: m.BrandLoader, maxMs: loaderMaxMs(now) });
      },
      () => dropAttr(),
    );
    const giveUp = window.setTimeout(
      dropAttr,
      Math.max(0, GIVE_UP_MS - performance.now()),
    );
    return () => {
      live = false;
      window.clearTimeout(giveUp);
    };
  }, [up]);

  if (!up) return null;
  return (
    <div className={styles.shell} data-stage-loader-shell="">
      {loaded ? (
        <loaded.Loader
          ready={ready}
          maxMs={loaded.maxMs}
          onLeave={onLeave}
          onDone={dropAttr}
        />
      ) : (
        // BrandLoader's own first frame: the ink cover, nothing drawn yet.
        <div
          role="status"
          aria-label="Loading Polycards"
          className="fixed inset-0 z-[1000] bg-neutral-950"
        />
      )}
    </div>
  );
}

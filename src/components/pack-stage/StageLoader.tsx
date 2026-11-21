'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  leaveAtMs,
  type LoaderTimings,
} from '@/components/loader/loader-timeline';
import { useStage3d } from './Stage3dProvider';
import { StageLoaderMark, markRevealElapsed } from './stage-loader-mark';
import {
  ENTRY_LEAVE_LIFT_MS,
  ENTRY_LOADER_MAX_MS,
  FLOW_ENTRY_ATTR,
  FLOW_LEAVE_ATTR,
  HOME_LOADER_MAX_MS,
  LOADER_LATE_AT_MS,
  STAGE_LOADER_ATTR,
  loaderTimings,
} from './stage-loader-script';
import { goToPackPage, pendingEntry } from './stage-entry-cover';
import styles from './pack-stage.module.css';

function subscribe(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: [STAGE_LOADER_ATTR, FLOW_ENTRY_ATTR],
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

type Plan = { at: number; timings: LoaderTimings; readyAt: number | null };

/**
 * The stage's brand loader. The shell is in every server render, shown by CSS
 * only under `html[data-stage-loader]`, and its mark (StageLoaderMark) starts
 * drawing at the first paint, with no script: hydration takes the same nodes
 * over, so nothing restarts. On hydration it unmounts at once when that
 * attribute is absent (a reduced-motion or low-data visitor, a crash flag,
 * ?loader=never). It never decides itself: the inline script did.
 *
 * It leaves when the reveal is over and the 3D stage is ready (or settled
 * flat), and at the latest HOME_LOADER_MAX_MS after navigation start; a page
 * hydrating after LOADER_LATE_AT_MS lets go at once, with no exit. `onLeave`
 * fires as the exit fade starts; the end of the fade, or unmounting, drops
 * the html attribute.
 *
 * A load onto a pack's own address (`html[data-flow-entry]`) is different:
 * the cover stays, whenever the page hydrates, until the flow has placed the
 * pack on its stop (it removes that attribute), so the visitor never sees the
 * row; at ENTRY_LOADER_MAX_MS it takes today's pack page instead. That limit
 * runs only while the tab shows: a hidden tab paints no frames, so the pack
 * cannot be placed there, and the tab coming forward gets the full limit
 * again. A leave whose pack page never comes lifts the cover
 * ENTRY_LEAVE_LIFT_MS later.
 */
export default function StageLoader({ onLeave }: { onLeave?: () => void }) {
  const up = useStageLoaderUp(true);
  const stage3d = useStage3d();
  // the pack being placed by this load onto its address (null: none, or placed)
  const entry = useSyncExternalStore(
    subscribe,
    () => pendingEntry(),
    () => null,
  );
  // whether this load is one onto a pack's address (read once, at hydration)
  const [entryLoad] = useState(() =>
    typeof document === 'undefined' ? false : pendingEntry() !== null,
  );
  // gone for today's pack page: the cover stays, whatever happens meanwhile
  const [leavingPage, setLeavingPage] = useState(false);
  const ready =
    (stage3d.ready || stage3d.mode === 'flat') &&
    !(entryLoad && entry) &&
    !leavingPage;
  const [leaving, setLeaving] = useState(false);
  // read by the entry limit's timer: an exit under way owns the cover's end
  const leavingRef = useRef(false);
  useEffect(() => {
    leavingRef.current = leaving;
  }, [leaving]);
  const shellRef = useRef<HTMLDivElement>(null);
  const planRef = useRef<Plan | null>(null);
  const onLeaveRef = useRef(onLeave);
  useEffect(() => {
    onLeaveRef.current = onLeave;
  }, [onLeave]);

  useEffect(() => dropAttr, []);

  useEffect(() => {
    if (!up) return;
    if (entryLoad) {
      let limit: number | undefined;
      let lift: number | undefined;
      let fired = false;
      // not placed in time: today's pack page, with the cover still up
      const onLimit = () => {
        fired = true;
        const id = pendingEntry();
        if (id === null) {
          // placed: a running exit fade drops the cover at its end
          if (!leavingRef.current) dropAttr();
          return;
        }
        document.documentElement.setAttribute(FLOW_LEAVE_ATTR, '');
        setLeavingPage(true);
        goToPackPage(id);
        // that page never came: lift the cover rather than hold it for good
        lift = window.setTimeout(() => {
          document.documentElement.removeAttribute(FLOW_LEAVE_ATTR);
          dropAttr();
        }, ENTRY_LEAVE_LIFT_MS);
      };
      const arm = (ms: number) => {
        window.clearTimeout(limit);
        limit = window.setTimeout(onLimit, Math.max(0, ms));
      };
      // a hidden tab runs no limit; coming forward gives the full one again
      const onVisibility = () => {
        if (fired) return;
        if (document.hidden) window.clearTimeout(limit);
        else arm(ENTRY_LOADER_MAX_MS);
      };
      if (!document.hidden) arm(ENTRY_LOADER_MAX_MS - performance.now());
      document.addEventListener('visibilitychange', onVisibility);
      return () => {
        window.clearTimeout(limit);
        window.clearTimeout(lift);
        document.removeEventListener('visibilitychange', onVisibility);
      };
    }
    // Hydrated too late for an exit (a slow device or network; the CSS
    // failsafe is about to show the page): just let go.
    if (performance.now() > LOADER_LATE_AT_MS) {
      dropAttr();
      return;
    }
    const giveUp = window.setTimeout(
      dropAttr,
      Math.max(0, GIVE_UP_MS - performance.now()),
    );
    return () => window.clearTimeout(giveUp);
  }, [up, entryLoad]);

  // The exit timer, planned once at hydration so `ready` flipping never
  // restarts it: the reveal goes on from where the CSS clock is.
  useEffect(() => {
    if (!up || leaving) return;
    const now = performance.now();
    if (!planRef.current) {
      if (now > LOADER_LATE_AT_MS && !entryLoad) return;
      const timings = loaderTimings(now, markRevealElapsed(shellRef.current));
      planRef.current = {
        at: now,
        // an entry load has no cap of its own here: it leaves once placed
        timings: entryLoad ? { ...timings, maxMs: Infinity } : timings,
        readyAt: null,
      };
    }
    const plan = planRef.current;
    const elapsed = now - plan.at;
    if (ready && plan.readyAt === null) plan.readyAt = elapsed;
    const leaveAt = leaveAtMs(plan.readyAt, plan.timings);
    if (!Number.isFinite(leaveAt)) return;
    const wait = Math.max(0, leaveAt - elapsed);
    const id = window.setTimeout(() => setLeaving(true), wait);
    return () => window.clearTimeout(id);
  }, [up, ready, leaving, entryLoad]);

  useEffect(() => {
    if (!leaving) return;
    onLeaveRef.current?.();
    const id = window.setTimeout(
      dropAttr,
      planRef.current?.timings.exitMs ?? 0,
    );
    return () => window.clearTimeout(id);
  }, [leaving]);

  if (!up) return null;
  return (
    <div ref={shellRef} className={styles.shell} data-stage-loader-shell="">
      <StageLoaderMark leaving={leaving} />
    </div>
  );
}

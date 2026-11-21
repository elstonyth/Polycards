'use client';

import {
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type CSSProperties,
  type Ref,
  type RefObject,
} from 'react';
import {
  animate,
  observable,
  type AnimationControls,
  type Observable,
} from './stage-motion';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { StagePack } from './contract';
import { useStage3d } from './Stage3dProvider';
import { SLEEVE_TILE } from './stage-capsule-lean';
import { spinKit } from './stage-spin-load';
import {
  SPIN_LOCK,
  STAGE_REACH,
  rowPaintState,
  rowPosedByKit,
} from './stage-pose';
import { stageStartIndex } from './stage-filter';
import StageTile, { tileVars } from './StageTile';
import styles from './pack-stage.module.css';

// The start rule lives with the row filter (pure, shared with the chips).
export { STAGE_START_INDEX, stageStartIndex } from './stage-filter';

/**
 * Where a released swipe lands: the nearest pack to where the release speed
 * would carry the track, at least one pack on from where the swipe started
 * once it is a deliberate swipe, and never more than MAX_FLING packs.
 */
export function swipeTarget({
  from,
  at,
  velocity,
  count,
}: {
  /** Track at the start of the swipe. */
  from: number;
  /** Track at release. */
  at: number;
  /** Track units per second (positive = towards later packs). */
  velocity: number;
  count: number;
}): number {
  const projected = at + velocity * FLING_S;
  let target = Math.round(projected);
  const origin = Math.round(from);
  const moved = at - from;
  if (
    target === origin &&
    (Math.abs(moved) > NUDGE || Math.abs(velocity) > NUDGE_SPEED)
  ) {
    target = origin + Math.sign(Math.abs(moved) > NUDGE ? moved : velocity);
  }
  target = Math.max(origin - MAX_FLING, Math.min(origin + MAX_FLING, target));
  return Math.max(0, Math.min(count - 1, target));
}

/** Seconds of release speed a swipe carries forward. */
const FLING_S = 0.16;
/** A swipe past this fraction of a step moves on one pack... */
const NUDGE = 0.12;
/** ...and so does a flick faster than this (steps per second). */
const NUDGE_SPEED = 1.2;
const MAX_FLING = 3;
/** Rubber band past either end, as a fraction of the overshoot. */
const EDGE_GIVE = 0.25;
/** Sideways travel (px) before a press becomes a swipe. */
const PAN_SLOP = 8;
/** The track's settle: the soft.tsx curve's feel, as a spring that keeps a
 *  swipe's release speed. */
const SETTLE = {
  type: 'spring',
  stiffness: 260,
  damping: 32,
  restDelta: 0.001,
} as const;
/** Camera field of view the 3D stage renders with. The CSS
 *  perspective is that camera's distance in CSS px. */
const CAMERA_FOV_DEG = 28;

export type StageTrackHandle = {
  /** Centre pack `index` (clamped), animated unless reduced motion. */
  go(index: number): void;
  /** The continuous centred index (the lineup's pick writes it). */
  track: Observable<number>;
  /** The row on show. */
  packs: readonly StagePack[];
};

/**
 * One category's carousel. A motion value holds the
 * continuous centred index; every change is written straight into the tiles'
 * CSS pose (no React render per frame) and read by the 3D provider through
 * `attach`. Moves by swipe (horizontal pan only: `touch-action: pan-y` keeps
 * vertical scroll the page's), the previous/next discs, tapping or focusing a
 * neighbour, and arrows / Home / End while focus is inside.
 */
export default function StageTrack({
  categoryId,
  packs,
  active,
  noun,
  reduced,
  priority,
  host,
  handle,
  onSelect,
  onSettle,
  selected,
  startAt,
  rowKey,
}: {
  categoryId: string;
  /** The row on show (the category's packs, narrowed by the chips). */
  packs: readonly StagePack[];
  /** Where the row opens (default: the start rule). Read when the row changes. */
  startAt?: number;
  /** Changes whenever the row does (category, chip, language): reopens it at `startAt`. */
  rowKey?: string;
  /** The visible category: only it attaches to the 3D layer and measures. */
  active: boolean;
  noun: 'pack' | 'capsule';
  reduced: boolean;
  /** The first category: its starting pack is the page's likely LCP. */
  priority: boolean;
  /** The stage section: the 3D host the perspective is measured against. */
  host: RefObject<HTMLElement | null>;
  handle?: Ref<StageTrackHandle>;
  /** The pack the track is heading to (the info block follows at once). */
  onSelect: (index: number) => void;
  /** The track has come to rest on `index` after a move (for the live region). */
  onSettle: (index: number) => void;
  /** The centred (or heading-to) pack, for the ends of the previous/next discs. */
  selected: number;
}) {
  const start =
    startAt === undefined
      ? stageStartIndex(packs)
      : Math.max(0, Math.min(packs.length - 1, startAt));
  // The continuous centred index: one observable for the life of the track.
  const [track] = useState(() => observable(start));
  const stage3d = useStage3d();
  const trackId = useId();
  const viewportRef = useRef<HTMLDivElement>(null);
  const rowRef = useRef<HTMLUListElement>(null);
  const animRef = useRef<AnimationControls | null>(null);
  const targetRef = useRef(start);
  const cyArtRef = useRef(0);
  const panRef = useRef<{ from: number; step: number } | null>(null);
  const pannedRef = useRef(false);
  const pressCentreRef = useRef<number | null>(null);
  const count = packs.length;
  // The provider's shared animation state: the float-in, the category swap
  // and the pointer lean (it listens for the pointer itself). Flat or 3D, both
  // layers pose from these same values.
  const { values, attach, state: live } = stage3d;
  const hostRef = host;

  // Every frame of a move: the row slides by whole steps, each tile re-poses.
  const paint = useCallback(() => {
    const row = rowRef.current;
    if (!row) return;
    const t = track.get();
    // the focused view's and the lap's own values: a repaint mid-focus or in
    // the lap (the track still easing after Tab walked the row) keeps their poses
    const state = rowPaintState(
      t,
      {
        intro: values.intro.get(),
        swap: values.swap.get(),
        pointerX: values.pointerX.get(),
        pointerY: values.pointerY.get(),
        spin: values.spin.get(),
        exit: values.exit.get(),
      },
      live,
    );
    row.style.setProperty('--track', String(Math.round(t * 10000) / 10000));
    // The spin row (the packshot lineup) and the focused view are posed by the
    // lazily loaded chunk: the same pose the canvas draws, so a tile without
    // a 3D pack stands in place. At rest (or before the chunk) the plain carousel's.
    const host = hostRef.current;
    if (
      rowPosedByKit(state) &&
      host &&
      spinKit()?.paintTiles(row, host, packs, state, cyArtRef.current)
    )
      return;
    const tiles = row.children;
    for (let i = 0; i < tiles.length; i++) {
      const tile = tiles[i] as HTMLElement;
      const entry = packs[i] ?? SLEEVE_TILE;
      const vars = tileVars(
        i,
        state,
        entry.soldOut,
        cyArtRef.current,
        entry.ticket,
      );
      for (const key in vars) tile.style.setProperty(key, vars[key] ?? '');
    }
  }, [track, packs, values, hostRef, live]);

  // Only the visible category follows the shared values. Layout effects, here
  // and below: a changed row (React re-renders the tiles' rest pose into their
  // style) is re-posed, re-centred and attached before the browser paints and
  // before the rise's first frame.
  useLayoutEffect(() => {
    if (!active) return;
    const offs = [
      track.on('change', paint),
      values.intro.on('change', paint),
      values.swap.on('change', paint),
      values.pointerX.on('change', paint),
      values.pointerY.on('change', paint),
      values.spin.on('change', paint),
      values.exit.on('change', paint),
    ];
    paint();
    return () => offs.forEach((off) => off());
  }, [active, track, values, paint]);

  const go = useCallback(
    (index: number, velocity = 0) => {
      const target = Math.max(0, Math.min(count - 1, Math.round(index)));
      targetRef.current = target;
      onSelect(target);
      animRef.current?.stop();
      if (reduced) {
        track.set(target);
        onSettle(target);
        return;
      }
      if (Math.abs(track.get() - target) < 0.001 && velocity === 0) {
        track.set(target);
        return;
      }
      animRef.current = animate(track, target, {
        ...SETTLE,
        velocity,
        onComplete: () => onSettle(target),
      });
    },
    [count, onSelect, onSettle, reduced, track],
  );

  useImperativeHandle(handle, () => ({ go, track, packs }), [go, track, packs]);

  // A category becoming visible, or a changed row, opens at its start.
  useLayoutEffect(() => {
    if (!active) return;
    animRef.current?.stop();
    targetRef.current = start;
    track.set(start);
    paint();
  }, [active, start, rowKey, track, paint]);

  // The 3D layer draws this category while it is the visible one.
  useLayoutEffect(() => {
    if (!active) return;
    return attach({
      categoryId,
      packs,
      track,
      artElement: (i) =>
        rowRef.current?.querySelector<HTMLElement>(
          `[data-index="${i}"] [data-stage-art]`,
        ) ?? null,
    });
  }, [active, attach, categoryId, packs, track]);

  // Perspective = the 3D camera's distance in CSS px, from the host centre.
  useEffect(() => {
    const hostEl = host.current;
    const viewport = viewportRef.current;
    if (!active || !hostEl || !viewport) return;
    const measure = () => {
      const h = hostEl.getBoundingClientRect();
      const v = viewport.getBoundingClientRect();
      if (h.height === 0) return;
      const distance =
        h.height / (2 * Math.tan(((CAMERA_FOV_DEG / 2) * Math.PI) / 180));
      viewport.style.setProperty('--persp', `${distance.toFixed(1)}px`);
      viewport.style.setProperty(
        '--po-x',
        `${(h.left + h.width / 2 - v.left).toFixed(1)}px`,
      );
      viewport.style.setProperty(
        '--po-y',
        `${(h.top + h.height / 2 - v.top).toFixed(1)}px`,
      );
      // The art centre's height in the host, in art heights (float-in drop).
      const art =
        rowRef.current?.querySelector<HTMLElement>('[data-stage-art]');
      const a = art?.getBoundingClientRect();
      if (a && a.height > 0)
        cyArtRef.current = (a.top + a.height / 2 - h.top) / a.height;
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(hostEl);
    return () => observer.disconnect();
  }, [active, host]);

  // ---- Swipe ---------------------------------------------------------------

  // Plain pointer events (no motion component in the page's first load). A
  // press becomes a swipe once it travels PAN_SLOP px mostly sideways; a
  // vertical move never does, and on touch the browser takes it as a scroll
  // (touch-action: pan-y) and cancels the pointer.
  const pressRef = useRef<{
    id: number;
    x0: number;
    y0: number;
    samples: { t: number; x: number }[];
  } | null>(null);

  const onPointerDown = (event: PointerEvent) => {
    pannedRef.current = false;
    pressCentreRef.current = targetRef.current;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    pressRef.current = {
      id: event.pointerId,
      x0: event.clientX,
      y0: event.clientY,
      samples: [{ t: event.timeStamp, x: event.clientX }],
    };
  };

  const onPointerMove = (event: PointerEvent) => {
    const press = pressRef.current;
    if (!press || press.id !== event.pointerId) return;
    const dx = event.clientX - press.x0;
    if (!panRef.current) {
      // The spin owns the row once it has started: no new swipe. A
      // swipe already under way finishes its snap.
      if (values.spin.get() >= SPIN_LOCK) return;
      const dy = event.clientY - press.y0;
      if (Math.abs(dx) < PAN_SLOP || Math.abs(dx) <= Math.abs(dy)) return;
      const step =
        rowRef.current?.firstElementChild?.getBoundingClientRect().width ?? 0;
      if (step <= 0) return;
      animRef.current?.stop();
      pannedRef.current = true;
      panRef.current = { from: track.get(), step };
      viewportRef.current?.setPointerCapture?.(event.pointerId);
    }
    const pan = panRef.current;
    press.samples.push({ t: event.timeStamp, x: event.clientX });
    if (press.samples.length > 6) press.samples.shift();
    let t = pan.from - dx / pan.step;
    const max = count - 1;
    if (t < 0) t *= EDGE_GIVE;
    else if (t > max) t = max + (t - max) * EDGE_GIVE;
    track.set(t);
  };

  const endPress = (event: PointerEvent) => {
    const press = pressRef.current;
    if (!press || press.id !== event.pointerId) return;
    pressRef.current = null;
    const pan = panRef.current;
    panRef.current = null;
    if (!pan) return;
    // Release speed over the last ~100 ms of the swipe, in px per second.
    const recent = press.samples.filter((s) => event.timeStamp - s.t < 100);
    const first = recent[0];
    const last = recent[recent.length - 1];
    const pxPerS =
      first && last && last.t > first.t
        ? ((last.x - first.x) / (last.t - first.t)) * 1000
        : 0;
    const velocity = event.type === 'pointercancel' ? 0 : -pxPerS / pan.step;
    go(
      swipeTarget({ from: pan.from, at: track.get(), velocity, count }),
      velocity,
    );
  };

  // ---- Tap, focus, keys ------------------------------------------------------

  // A swipe that ends over a tile must not also open it.
  const onClickCapture = (event: MouseEvent) => {
    if (!pannedRef.current) return;
    pannedRef.current = false;
    event.preventDefault();
    event.stopPropagation();
  };

  const onFocusTile = (index: number) => {
    if (index !== targetRef.current) go(index);
  };

  // Only the centred pack opens; a neighbour is centred first. Judged by the
  // centre at the press, since a mouse press focuses (and so centres) first.
  const onClickTile = (index: number, event: MouseEvent) => {
    const centre = pressCentreRef.current ?? targetRef.current;
    pressCentreRef.current = null;
    if (index !== centre || packs[index]?.soldOut) {
      event.preventDefault();
      go(index);
    }
  };

  const focusTile = (index: number) => {
    rowRef.current
      ?.querySelector<HTMLElement>(`[data-index="${index}"] [data-stage-hit]`)
      ?.focus({ preventScroll: true });
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (values.spin.get() >= SPIN_LOCK) return;
    const at = targetRef.current;
    const next =
      event.key === 'ArrowLeft'
        ? at - 1
        : event.key === 'ArrowRight'
          ? at + 1
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? count - 1
              : null;
    if (next === null) return;
    event.preventDefault();
    const target = Math.max(0, Math.min(count - 1, next));
    go(target);
    focusTile(target);
  };

  const disc =
    'flex h-11 w-11 items-center justify-center rounded-full border border-white/10 bg-neutral-900/80 text-white transition-[background-color,opacity,transform] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] hover:bg-neutral-800 active:scale-[0.94] focus-visible:ring-2 focus-visible:ring-white/40 focus-visible:outline-none aria-disabled:cursor-default aria-disabled:opacity-30 aria-disabled:hover:bg-neutral-900/80 motion-reduce:transition-none';

  return (
    <div
      ref={viewportRef}
      data-stage-viewport=""
      className={styles.viewport}
      onPointerDownCapture={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPress}
      onPointerCancel={endPress}
      onClickCapture={onClickCapture}
      onDragStart={(event) => event.preventDefault()}
    >
      <div aria-hidden className={styles.pool} />
      <button
        type="button"
        data-stage-nav=""
        aria-label={`Previous ${noun}`}
        aria-controls={trackId}
        // aria-disabled, not disabled: a focused disc must keep focus at the end.
        aria-disabled={selected <= 0 || undefined}
        onClick={() => go(targetRef.current - 1)}
        className={cn(disc, styles.nav, styles.navPrev)}
      >
        <ChevronLeft className="h-5 w-5" strokeWidth={1.75} aria-hidden />
      </button>
      <ul
        ref={rowRef}
        id={trackId}
        data-stage-row=""
        className={styles.row}
        style={{ '--track': String(start) } as CSSProperties}
        onKeyDown={onKeyDown}
      >
        {packs.map((pack, i) => (
          <StageTile
            key={pack.id}
            pack={pack}
            index={i}
            count={count}
            start={start}
            priority={priority && i === start}
            eager={Math.abs(i - start) <= STAGE_REACH.desktop}
            onFocusTile={onFocusTile}
            onClickTile={onClickTile}
          />
        ))}
      </ul>
      <button
        type="button"
        data-stage-nav=""
        aria-label={`Next ${noun}`}
        aria-controls={trackId}
        aria-disabled={selected >= count - 1 || undefined}
        onClick={() => go(targetRef.current + 1)}
        className={cn(disc, styles.nav, styles.navNext)}
      >
        <ChevronRight className="h-5 w-5" strokeWidth={1.75} aria-hidden />
      </button>
    </div>
  );
}

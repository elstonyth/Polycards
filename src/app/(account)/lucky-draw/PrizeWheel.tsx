'use client';

// The prize wheel (boss feedback 2026-10-25). At rest the prizes float in a
// ring round the next draw's countdown. Tapping one opens the ring into a
// vertical drum with that prize flat and full size at the front, and its
// details beside (desktop) or under (mobile) the wheel. The list under the
// ring is the at-a-glance index and the keyboard / screen-reader path.
//
// Adapted from crafterui's WorksWheel, Copyright (c) 2026 CrafterUI, MIT
// License (github.com/SriSomanaath/crafterui/blob/main/LICENSE). Changes: it
// never takes over page scroll (it sits mid-page), cards are portrait, the
// ring drifts and bobs, and opening and turning ease separately so a tapped
// card comes straight to the front instead of the drum winding round to it.
//
// Two eased numbers drive it, written to the DOM by one rAF pass, so turning
// is not a render: `open` (0 = ring, 1 = drum) and `pos` (the drum's front
// item). Only the settled front item and open/closed are React state.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ChevronDown, ChevronRight, ChevronUp, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { num, rmAuto } from '@/lib/format';
import { usePrefersReducedMotion } from '@/lib/use-reveal';
import { countdownClock, drawCountdown, nextDraw } from '@/lib/lucky-draw';
import type { LuckyDrawPrize } from '@/lib/data/schemas';
import { PrizeArt } from './PrizeCard';

/* Geometry, tuned at 375 px and 1440 px. The front card is measured against
   the stage, the drum against the card, the ring against the stage. */
const CARD_H = 0.64; // front card height, of the stage height
const CARD_MAX_W = 0.5; // ... but never wider than this much of the stage
const CARD_RATIO = 5 / 7; // portrait: card slabs and art
const STEP = 34; // degrees between cards on the drum
const DRUM = 1.7; // drum radius, in card heights (and BOW, LENS likewise)
const BOW = 1.4; // the drum's sideways arc (see WorksWheel)
const LENS = 3; // perspective distance
const CULL = 1.6; // drum items either side of the front still drawn
const RING_R = 0.69; // ring radius, of half the stage
const RING_BAND = 0.52; // tallest a ring card may be, of half the stage
const HUB = 0.4; // the countdown's clear radius, of half the stage
// shortcut: the ring shows the first 12 prizes (the rest stay in the list and
// the drum); a 13th card would shrink every card below thumbnail size.
// Revisit if an event ever runs more than 12 prizes.
const RING_MAX = 12;
const DRIFT = 3; // degrees per second the ring turns at rest
const EASE = 0.12; // fraction of the remaining distance closed per frame

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const rad = (deg: number) => (deg * Math.PI) / 180;
/** Into [-180, 180): a ring card unwinds the short way round as it opens. */
const wrap = (deg: number) => ((((deg + 180) % 360) + 360) % 360) - 180;

/** Both states in one chain (WorksWheel's `place`): the ring terms fall away
 *  as `m` reaches the drum, the drum terms are zero while the ring is up. */
function place(
  ringDeg: number,
  drumDeg: number,
  ringR: number,
  drumR: number,
  bow: number,
  m: number,
) {
  const bowX = -bow * (1 - Math.cos(rad(drumDeg)));
  return (
    `translateX(${m * bowX}px)` +
    ` rotateZ(${(1 - m) * ringDeg}deg) translateY(${-(1 - m) * ringR}px)` +
    ` rotateX(${m * drumDeg}deg) translateZ(${m * drumR}px)`
  );
}

const CLOCK_UNITS = [
  ['d', 'Days'],
  ['h', 'Hrs'],
  ['m', 'Min'],
  ['s', 'Sec'],
] as const;

export function PrizeWheel({
  prizes,
  nowMs,
  details,
}: {
  prizes: LuckyDrawPrize[];
  /** Null until mounted: the countdowns are client-only (hydration). */
  nowMs: number | null;
  /** The full prize card for the front prize. */
  details: (prize: LuckyDrawPrize) => ReactNode;
}) {
  const reduced = usePrefersReducedMotion();
  const stageRef = useRef<HTMLDivElement>(null);
  const wheelRef = useRef<HTMLDivElement>(null);
  const hubRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const open = useRef(0);
  const openTo = useRef(0);
  const pos = useRef(0);
  const posTo = useRef(0);
  const spin = useRef(0);
  const hovering = useRef(false);
  const drag = useRef<{
    x: number;
    y: number;
    lastX: number;
    lastY: number;
    moved: boolean;
  } | null>(null);

  const [opened, setOpened] = useState(false);
  const [active, setActive] = useState(0);
  const [stage, setStage] = useState({ w: 0, h: 0 });

  const count = prizes.length;
  const last = Math.max(count - 1, 0);
  const ringCount = Math.min(count, RING_MAX);

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const read = () => setStage({ w: el.clientWidth, h: el.clientHeight });
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const metrics = useMemo(() => {
    const { w, h } = stage;
    const half = Math.min(w, h) / 2;
    const cardH = Math.min(h * CARD_H, (w * CARD_MAX_W) / CARD_RATIO);
    const cardW = cardH * CARD_RATIO;
    const ringR = half * RING_R;
    // Tangent cards: each one's width must fit its share of the circle, its
    // height the band between the countdown and the stage edge.
    const chord = 2 * ringR * Math.sin(Math.PI / Math.max(ringCount, 3));
    const ringScale = cardH
      ? Math.min((chord * 0.9) / cardW, (half * RING_BAND) / cardH)
      : 1;
    return {
      half,
      cardW,
      cardH,
      ringR,
      ringScale,
      drumR: cardH * DRUM,
      bow: cardH * BOW,
      depth: cardH * LENS,
      bob: half * 0.018,
    };
  }, [stage, ringCount]);

  // One pass per frame: ease, drift, then write every transform.
  useEffect(() => {
    if (!stage.h) return;
    let frame = 0;
    let lastTs = 0;
    const { ringR, ringScale, drumR, bow, bob } = metrics;
    const ringStep = 360 / Math.max(ringCount, 1);
    const k = reduced ? 1 : EASE;

    const draw = (ts: number) => {
      frame = requestAnimationFrame(draw);
      const dt = lastTs ? Math.min(ts - lastTs, 64) : 16;
      lastTs = ts;
      const ease = (cur: number, to: number) =>
        Math.abs(to - cur) < 0.0005 ? to : cur + (to - cur) * k;
      open.current = ease(open.current, openTo.current);
      pos.current = ease(pos.current, posTo.current);
      const m = open.current;
      if (!reduced && m === 0 && !hovering.current && !drag.current) {
        spin.current = (spin.current + (DRIFT * dt) / 1000) % 360;
      }

      if (wheelRef.current) {
        wheelRef.current.style.transform = `translateZ(${-m * drumR}px)`;
      }
      for (let i = 0; i < count; i++) {
        const card = cardRefs.current[i];
        if (!card) continue;
        const d = i - pos.current;
        const lift = reduced ? 0 : Math.sin(ts / 900 + i * 1.7) * bob;
        card.style.transform = place(
          wrap(i * ringStep + spin.current),
          -d * STEP, // the next prize waits below the front
          ringR + lift,
          drumR,
          bow,
          m,
        );
        // Past the ring's cap a card only exists on the drum.
        const onRing = i < RING_MAX ? 1 : 0;
        const onDrum = Math.abs(d) > CULL ? 0 : 1;
        card.style.opacity = String(lerp(onRing, onDrum, m));
        card.style.zIndex = String(Math.round(100 - Math.abs(d) * 2 * m));
        card.style.pointerEvents = lerp(onRing, onDrum, m) > 0.5 ? '' : 'none';
        const face = card.firstElementChild as HTMLElement | null;
        if (face) face.style.transform = `scale(${lerp(ringScale, 1, m)})`;
      }
      if (hubRef.current) {
        hubRef.current.style.opacity = String(clamp(1 - m * 1.6, 0, 1));
      }
      const near = clamp(Math.round(pos.current), 0, last);
      setActive((prev) => (prev === near ? prev : near));
    };

    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [metrics, stage.h, count, ringCount, last, reduced]);

  const show = useCallback(
    (i: number) => {
      const to = clamp(i, 0, last);
      // From the ring, jump the drum straight to the card: its terms are
      // still zero, so nothing moves until `open` eases up.
      if (open.current < 0.05) pos.current = to;
      posTo.current = to;
      openTo.current = 1;
      setOpened(true);
    },
    [last],
  );

  const close = useCallback(() => {
    openTo.current = 0;
    setOpened(false);
  }, []);

  const turn = useCallback(
    (dir: 1 | -1) => {
      posTo.current = clamp(Math.round(posTo.current) + dir, 0, last);
    },
    [last],
  );

  const onCard = (i: number) => {
    if (!opened || i !== active) show(i);
  };

  const hub = nowMs == null ? null : nextDraw(prizes, nowMs);
  const clock =
    hub?.kind === 'next' && nowMs != null
      ? countdownClock(hub.at, nowMs)
      : null;
  const pool = prizes.reduce((n, p) => n + p.value_myr, 0);
  const half = metrics.half;
  const front = prizes[clamp(active, 0, last)];

  return (
    <section
      aria-label="Prizes"
      className="lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)] lg:items-start lg:gap-8"
      onKeyDown={(e) => {
        if (!opened) return;
        if (e.key === 'Escape') close();
        else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') turn(1);
        else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') turn(-1);
        else return;
        e.preventDefault();
      }}
    >
      <div
        ref={stageRef}
        className="relative mx-auto aspect-square w-full max-w-[38rem] touch-pan-y overflow-hidden rounded-3xl bg-[radial-gradient(circle_at_50%_50%,rgba(255,255,255,0.06),transparent_62%)] select-none"
        onPointerEnter={(e) => {
          if (e.pointerType === 'mouse') hovering.current = true;
        }}
        onPointerLeave={() => {
          hovering.current = false;
        }}
        onPointerDown={(e) => {
          drag.current = {
            x: e.clientX,
            y: e.clientY,
            lastX: e.clientX,
            lastY: e.clientY,
            moved: false,
          };
        }}
        onPointerMove={(e) => {
          const g = drag.current;
          if (!g) return;
          if (!g.moved) {
            if (Math.hypot(e.clientX - g.x, e.clientY - g.y) < 6) return;
            // Captured only once it is a drag, so a tap still clicks its card.
            g.moved = true;
            e.currentTarget.setPointerCapture(e.pointerId);
          }
          const dx = e.clientX - g.lastX;
          const dy = e.clientY - g.lastY;
          g.lastX = e.clientX;
          g.lastY = e.clientY;
          if (openTo.current === 1) {
            // Swipe left or up for the next prize.
            const delta = Math.abs(dx) > Math.abs(dy) ? dx : dy;
            posTo.current = clamp(
              posTo.current - delta / Math.max(metrics.cardH * 0.8, 1),
              0,
              last,
            );
          } else {
            spin.current += dx * 0.35;
          }
        }}
        onPointerUp={() => {
          if (drag.current?.moved && openTo.current === 1) {
            posTo.current = Math.round(posTo.current);
          }
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
          posTo.current = Math.round(posTo.current);
        }}
      >
        {/* The orbit line and the countdown: the ring's centrepiece. */}
        <div
          ref={hubRef}
          className="pointer-events-none absolute inset-0 grid place-items-center"
        >
          <span
            aria-hidden
            className="absolute rounded-full border border-white/[0.06]"
            style={{ width: metrics.ringR * 2, height: metrics.ringR * 2 }}
          />
          <div
            className="relative flex flex-col items-center text-center"
            style={{ maxWidth: half * HUB * 2.3 }}
          >
            <p
              className="font-semibold tracking-[0.24em] text-neutral-400 uppercase"
              style={{ fontSize: Math.max(10, half * 0.055) }}
            >
              {hub?.kind === 'done' ? 'All drawn' : 'Next draw'}
            </p>
            {hub?.kind === 'drawing' ? (
              <p
                className="font-heading mt-1 text-white"
                style={{ fontSize: Math.max(20, half * 0.12) }}
              >
                Drawing…
              </p>
            ) : hub?.kind === 'done' ? null : (
              <p
                className="font-heading mt-1.5 flex items-start text-white tabular-nums"
                role="timer"
                aria-label={
                  hub?.kind === 'next' && nowMs != null
                    ? `Next draw in ${drawCountdown(hub.at, nowMs)}`
                    : undefined
                }
                style={{
                  fontSize: Math.max(20, half * 0.12),
                  gap: Math.max(6, half * 0.035),
                }}
              >
                {CLOCK_UNITS.map(([key, unit]) => (
                  <span key={key} className="flex flex-col items-center">
                    <span className="leading-none">{clock?.[key] ?? '--'}</span>
                    <span
                      className="mt-1 font-sans font-semibold tracking-wider text-neutral-500 uppercase"
                      style={{ fontSize: Math.max(9, half * 0.04) }}
                    >
                      {unit}
                    </span>
                  </span>
                ))}
              </p>
            )}
            <p
              className="mt-2 text-neutral-300"
              style={{ fontSize: Math.max(11, half * 0.058) }}
            >
              {num(count)} {count === 1 ? 'prize' : 'prizes'} ·{' '}
              <span className="font-semibold text-chase">{rmAuto(pool)}</span>
            </p>
          </div>
        </div>

        <div
          className="absolute inset-0"
          style={{ perspective: `${metrics.depth}px` }}
        >
          <div
            ref={wheelRef}
            aria-hidden
            className="absolute top-1/2 left-1/2 [transform-style:preserve-3d]"
          >
            {prizes.map((p, i) => (
              <button
                key={p.id}
                type="button"
                tabIndex={-1}
                ref={(node) => {
                  cardRefs.current[i] = node;
                }}
                onClick={() => onCard(i)}
                className="absolute cursor-pointer outline-none [backface-visibility:hidden]"
                style={{
                  width: metrics.cardW,
                  height: metrics.cardH,
                  marginLeft: -metrics.cardW / 2,
                  marginTop: -metrics.cardH / 2,
                  opacity: 0,
                }}
              >
                <span
                  className={cn(
                    'relative block size-full overflow-hidden rounded-2xl border bg-neutral-900 p-[5%] shadow-[0_24px_60px_-24px_rgba(0,0,0,0.9)] transition-[border-color,filter] duration-300',
                    opened && i === active
                      ? 'border-white/25'
                      : 'border-white/10',
                    p.result && 'grayscale-[0.7] brightness-75',
                  )}
                >
                  <span className="relative block size-full">
                    <PrizeArt src={p.image} kind={p.kind} />
                  </span>
                </span>
              </button>
            ))}
          </div>
        </div>

        {opened && (
          <>
            <button
              type="button"
              onClick={close}
              aria-label="Back to all prizes"
              className="absolute top-3 left-3 z-[200] flex h-10 w-10 items-center justify-center rounded-full bg-neutral-900/80 text-neutral-200 backdrop-blur outline-none hover:text-white focus-visible:ring-2 focus-visible:ring-white/40"
            >
              <X className="h-5 w-5" aria-hidden />
            </button>
            <div className="absolute top-1/2 right-3 z-[200] flex -translate-y-1/2 flex-col items-center gap-2">
              <button
                type="button"
                onClick={() => turn(-1)}
                disabled={active <= 0}
                aria-label="Previous prize"
                className="flex h-10 w-10 items-center justify-center rounded-full bg-neutral-900/80 text-neutral-200 backdrop-blur outline-none hover:text-white focus-visible:ring-2 focus-visible:ring-white/40 disabled:opacity-30"
              >
                <ChevronUp className="h-5 w-5" aria-hidden />
              </button>
              <span className="text-xs font-semibold text-neutral-300 tabular-nums">
                {active + 1} / {count}
              </span>
              <button
                type="button"
                onClick={() => turn(1)}
                disabled={active >= last}
                aria-label="Next prize"
                className="flex h-10 w-10 items-center justify-center rounded-full bg-neutral-900/80 text-neutral-200 backdrop-blur outline-none hover:text-white focus-visible:ring-2 focus-visible:ring-white/40 disabled:opacity-30"
              >
                <ChevronDown className="h-5 w-5" aria-hidden />
              </button>
            </div>
          </>
        )}
      </div>

      <div className="mt-4 lg:mt-0">
        {opened && front ? (
          details(front)
        ) : (
          <ol className="divide-y divide-white/5 overflow-hidden rounded-2xl border border-white/10 bg-neutral-900">
            {prizes.map((p, i) => (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => show(i)}
                  className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors outline-none hover:bg-white/[0.04] focus-visible:bg-white/[0.06]"
                >
                  <span className="relative aspect-[5/7] w-10 shrink-0 overflow-hidden rounded-md border border-white/10 bg-white/[0.04] p-0.5">
                    <span className="relative block h-full w-full">
                      <PrizeArt src={p.image} kind={p.kind} />
                    </span>
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-white">
                      {p.title}
                    </span>
                    <span className="block truncate text-xs text-neutral-400 tabular-nums">
                      {p.result
                        ? p.result.winner
                          ? `Won by ${p.result.winner.who}`
                          : 'No entries'
                        : nowMs != null
                          ? drawCountdown(p.draw_at, nowMs)
                          : ' '}
                      {p.my_tickets > 0 && ` · You: ${num(p.my_tickets)}`}
                    </span>
                  </span>
                  <span className="font-heading shrink-0 text-sm text-chase tabular-nums">
                    {rmAuto(p.value_myr)}
                  </span>
                  <ChevronRight
                    className="h-4 w-4 shrink-0 text-neutral-500"
                    aria-hidden
                  />
                </button>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}

'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { num } from '@/lib/format';
import {
  HOLO_STOPS,
  holoConic,
  landingAngle,
  segmentAt,
  wheelSegments,
  winnerIndex,
  type WheelSegment,
} from '@/lib/lucky-draw';
import type { LuckyDrawResultDetail } from '@/lib/data/schemas';
import { createHoloDust } from './holo-dust';
import { PrizeArt } from './PrizeCard';

// The prize wheel (spec §10, style "K — Holo Foil", win effect "Holo dust +
// prize reveal"), ported from
// docs/superpowers/specs/assets/lucky-draw-spin-prototype.html. Decoration
// only: the server drew the winner; the spin is chosen to land on them.
//
// The face turns through SVG `transform` ATTRIBUTES, which rotate about the
// viewBox origin (the hub). CSS transform-origin on SVG groups is unreliable
// across browsers — the prototype's known fix.

const R = 243; // face radius in the 520-unit viewBox; the rim's edge sits at 247
const LABEL_R = 160;
const LABEL_MIN_DEG = 7.5;
const FILLS = ['#121213', '#1b1b1d']; // matte black, graphite
const STRIPE_DEG = 1.5;
// Motion: a small pull-back, a long quartic ease-out past the target, settle.
const WINDUP_MS = 320;
const MAIN_MS = 6900;
const SETTLE_MS = 520;
const PULLBACK_DEG = 7;
const OVERSHOOT_DEG = 1.4;
const REVEAL_AFTER_MS = 900;
const TELL_AFTER_MS = 1000;

const pt = (a: number, r: number) => {
  const rad = (a * Math.PI) / 180;
  return `${r * Math.sin(rad)} ${-r * Math.cos(rad)}`;
};
const arc = (a0: number, a1: number, r = R) =>
  a1 - a0 >= 359.999
    ? `M0 ${-r} A${r} ${r} 0 1 1 0 ${r} A${r} ${r} 0 1 1 0 ${-r} Z`
    : `M0 0 L${pt(a0, r)} A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${pt(a1, r)} Z`;
const easeOutQuart = (t: number) => 1 - Math.pow(1 - t, 4);
const easeInOut = (t: number) =>
  t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
const short = (name: string) =>
  name.length > 13 ? `${name.slice(0, 12)}…` : name;

/** 0 spinning · 1 stopped (dust, the winning wedge lit) · 2 prize rising ·
 *  3 winner told. */
type Step = 0 | 1 | 2 | 3;

function Face({ segs }: { segs: WheelSegment[] }) {
  return (
    <>
      {segs.flatMap((s, i) => {
        if (s.index !== null) {
          return [
            <path
              key={i}
              d={arc(s.a0, s.a1)}
              fill={FILLS[i % 2]}
              stroke="#e4e4e7"
              strokeOpacity={0.32}
              strokeWidth={0.5}
            />,
          ];
        }
        // The merged small entrants: one evenly striped arc, no names.
        const n = Math.max(1, Math.round((s.a1 - s.a0) / STRIPE_DEG));
        const w = (s.a1 - s.a0) / n;
        return Array.from({ length: n }, (_, k) => (
          <path
            key={`${i}-${k}`}
            d={arc(s.a0 + k * w, s.a0 + (k + 1) * w)}
            fill={FILLS[k % 2]}
          />
        ));
      })}
    </>
  );
}

/**
 * The wheel itself. Spins once on mount and lands on the stored winner;
 * under reduced motion it shows the winner directly (no spin, no dust).
 */
export function SpinWheel({
  detail,
  reduced,
}: {
  detail: LuckyDrawResultDetail;
  reduced: boolean;
}) {
  const { result, entries } = detail;
  const win = winnerIndex(entries, detail.ticket_index);
  const segs = useMemo(() => wheelSegments(entries, win), [entries, win]);
  const winSeg = useMemo(
    () => segs.find((s) => s.index === win) ?? null,
    [segs, win],
  );
  // Nothing to turn to (no readable winning wedge): tell the result as is.
  const [step, setStep] = useState<Step>(reduced || !winSeg ? 3 : 0);
  const faceRef = useRef<SVGGElement>(null);
  const pointerRef = useRef<SVGGElement>(null);
  const labelsRef = useRef<SVGGElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const face = faceRef.current;
    const pointer = pointerRef.current;
    const labels = labelsRef.current;
    const canvas = canvasRef.current;
    if (!winSeg || !face || !pointer || !labels || !canvas) return;
    const landAt = landingAngle(winSeg, Math.random());
    const turns = 6 + Math.floor(Math.random() * 2);
    const target = turns * 360 + ((360 - landAt) % 360);
    const turn = (deg: number) =>
      face.setAttribute('transform', `rotate(${deg})`);
    if (reduced) {
      turn(target);
      return;
    }

    const dust = createHoloDust(canvas);
    const timers: number[] = [];
    const end = WINDUP_MS + MAIN_MS + SETTLE_MS;
    const t0 = performance.now();
    let raf = 0;
    let last = t0;
    let rotation = 0;
    let lastRot = 0;
    let lastIdx = segmentAt(segs, 0);
    let stopped = false;
    // The pointer: a damped spring, kicked each time a wedge edge passes.
    let pAngle = 0;
    let pVel = 0;

    const frame = (now: number) => {
      const t = now - t0;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (t < WINDUP_MS) {
        rotation = -PULLBACK_DEG * easeInOut(t / WINDUP_MS);
      } else if (t < WINDUP_MS + MAIN_MS) {
        rotation =
          -PULLBACK_DEG +
          (target + OVERSHOOT_DEG + PULLBACK_DEG) *
            easeOutQuart((t - WINDUP_MS) / MAIN_MS);
      } else if (t < end) {
        rotation =
          target +
          OVERSHOOT_DEG *
            (1 - easeInOut((t - WINDUP_MS - MAIN_MS) / SETTLE_MS));
      } else {
        rotation = target;
      }
      turn(rotation);

      // Degrees per 60 fps frame: names fade while they blur past.
      const speed = Math.abs(rotation - lastRot) / Math.max(dt, 1e-3) / 60;
      lastRot = rotation;
      labels.style.opacity = speed > 9 ? '0.25' : speed > 4 ? '0.6' : '1';
      const idx = segmentAt(segs, rotation);
      if (idx !== lastIdx) {
        pAngle = Math.min(pAngle, -Math.min(16, 4 + speed * 0.9));
        lastIdx = idx;
      }
      pVel += (-520 * pAngle - 26 * pVel) * dt;
      pAngle += pVel * dt;
      pointer.setAttribute('transform', `rotate(${pAngle} 0 -264)`);

      if (t >= end && !stopped) {
        stopped = true;
        setStep(1);
        dust.burst();
        timers.push(
          window.setTimeout(() => {
            setStep(2);
            dust.wave(); // the second, softer wave off the card's top edge
          }, REVEAL_AFTER_MS),
          window.setTimeout(() => setStep(3), TELL_AFTER_MS),
        );
      }
      // A little longer than the spin, so the pointer spring comes to rest.
      if (t < end + 600) raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      timers.forEach((id) => window.clearTimeout(id));
      dust.stop();
    };
  }, [segs, winSeg, reduced]);

  const names = entries.map((e) => e.person.who);

  return (
    <div>
      <div className="relative mx-auto aspect-square w-[min(84vw,26rem)]">
        <div
          className={cn(
            'absolute inset-0 transition-[scale,filter] duration-900 ease-[cubic-bezier(.2,.8,.2,1)] motion-reduce:transition-none',
            step >= 2 && 'scale-86 brightness-38 saturate-80',
          )}
        >
          <svg
            viewBox="-260 -260 520 520"
            aria-hidden
            className="absolute inset-0 h-full w-full overflow-visible"
          >
            <defs>
              <radialGradient
                id="ld-face-shade"
                cx="0"
                cy="0"
                r="250"
                gradientUnits="userSpaceOnUse"
              >
                <stop offset="0" stopColor="#ffffff" stopOpacity=".05" />
                <stop offset=".7" stopColor="#000000" stopOpacity="0" />
                <stop offset="1" stopColor="#000000" stopOpacity=".45" />
              </radialGradient>
              <linearGradient
                id="ld-holo-fill"
                gradientUnits="userSpaceOnUse"
                x1="-120"
                y1="-240"
                x2="120"
                y2="0"
              >
                {HOLO_STOPS.map((c, i) => (
                  <stop
                    key={c}
                    offset={i / (HOLO_STOPS.length - 1)}
                    stopColor={c}
                  />
                ))}
                {!reduced && (
                  <animateTransform
                    attributeName="gradientTransform"
                    type="rotate"
                    from="0 0 -120"
                    to="360 0 -120"
                    dur="5s"
                    repeatCount="indefinite"
                  />
                )}
              </linearGradient>
              <radialGradient
                id="ld-pearl"
                cx="-6"
                cy="-8"
                r="34"
                gradientUnits="userSpaceOnUse"
              >
                <stop offset="0" stopColor="#ffffff" />
                <stop offset=".45" stopColor="#e6e3f0" />
                <stop offset=".8" stopColor="#b9c4d6" />
                <stop offset="1" stopColor="#7d8698" />
              </radialGradient>
              <filter id="ld-soft" x="-50%" y="-50%" width="200%" height="200%">
                <feGaussianBlur stdDeviation="6" />
              </filter>
            </defs>
            <circle
              r="252"
              fill="#000"
              opacity=".6"
              filter="url(#ld-soft)"
              transform="translate(0 10)"
            />
            <g ref={faceRef}>
              <Face segs={segs} />
              <g ref={labelsRef}>
                {segs.map((s, i) => {
                  if (s.index === null || s.a1 - s.a0 < LABEL_MIN_DEG) {
                    return null;
                  }
                  const mid = (s.a0 + s.a1) / 2;
                  return (
                    <text
                      key={i}
                      textAnchor="middle"
                      dominantBaseline="middle"
                      fill="#d4d4d8"
                      fontSize={11.5}
                      fontWeight={600}
                      letterSpacing=".02em"
                      // Along the radius, outside in, like a watch's chapter ring.
                      transform={`rotate(${mid}) translate(0 ${-LABEL_R}) rotate(${mid > 180 ? 90 : -90})`}
                    >
                      {short(names[s.index] ?? '')}
                    </text>
                  );
                })}
              </g>
              {winSeg && (
                <>
                  <path
                    d={arc(winSeg.a0, winSeg.a1)}
                    fill="url(#ld-holo-fill)"
                    opacity={step >= 1 ? 0.45 : 0}
                    className="transition-opacity duration-700 motion-reduce:transition-none"
                  />
                  {/* Everything but the winning wedge steps back (evenodd cut). */}
                  <path
                    d={`M-${R} 0 A${R} ${R} 0 1 0 ${R} 0 A${R} ${R} 0 1 0 -${R} 0 Z ${arc(winSeg.a0, winSeg.a1)}`}
                    fill="#000"
                    fillRule="evenodd"
                    opacity={step >= 1 ? 0.3 : 0}
                    className="pointer-events-none transition-opacity duration-600 motion-reduce:transition-none"
                  />
                </>
              )}
            </g>
            <circle r={R} fill="url(#ld-face-shade)" pointerEvents="none" />
            <circle r="26" fill="url(#ld-pearl)" />
            <circle
              r="26"
              fill="none"
              stroke="#ffffff"
              strokeOpacity=".35"
              strokeWidth=".8"
            />
            <g ref={pointerRef}>
              <path d="M0 -262 L-7.5 -262 L0 -226 L7.5 -262 Z" fill="#d9dde3" />
              <path d="M0 -262 L0 -226 L7.5 -262 Z" fill="#9aa1ab" />
              <circle
                cy="-264"
                r="5"
                fill="#e9ecf0"
                stroke="#7d8698"
                strokeWidth=".8"
              />
            </g>
          </svg>
          {/* The holo rim: a ring cut from a turning conic gradient that never
              turns with the wheel, so the foil light stays put like a lamp. */}
          <div
            aria-hidden
            className={cn(
              'holo-ring holo-turn absolute inset-[2.5%] rounded-full transition-[filter] duration-600',
              step >= 1
                ? 'brightness-115 saturate-125'
                : 'brightness-95 saturate-90',
            )}
            style={{ background: holoConic }}
          />
          <div
            aria-hidden
            className="pointer-events-none absolute inset-[2.5%] rounded-full bg-[radial-gradient(120%_70%_at_30%_8%,#ffffff22,transparent_45%)]"
          />
        </div>
        <canvas
          ref={canvasRef}
          aria-hidden
          className="pointer-events-none absolute -top-[20%] -left-[10%] h-full w-[120%]"
        />
        {/* The prize rises out of the hub in a thin holo-foil frame. */}
        <div
          aria-hidden
          className={cn(
            'pointer-events-none absolute inset-0 grid place-items-center transition-[opacity,translate,scale] delay-150 duration-700 ease-[cubic-bezier(.2,.8,.2,1)] motion-reduce:transition-none',
            step >= 2 ? 'opacity-100' : 'translate-y-[18px] scale-94 opacity-0',
          )}
        >
          <div
            className="holo-turn aspect-[5/7] w-[38%] rounded-[10px] p-[1.5px] shadow-[0_0_60px_#c4b5fd33,0_0_120px_#67e8f922] [--holo-period:6s]"
            style={{ background: holoConic }}
          >
            <div className="relative h-full w-full overflow-hidden rounded-[9px] bg-[radial-gradient(90%_60%_at_50%_30%,#2a2a2e,#121214_70%)] p-2">
              <span className="relative block h-full w-full">
                <PrizeArt src={result.image} sizes="180px" />
              </span>
            </div>
          </div>
        </div>
      </div>

      <div
        aria-live="polite"
        className={cn(
          'mt-4 min-h-20 text-center transition-[opacity,translate] duration-500 motion-reduce:transition-none',
          step >= 3 ? 'opacity-100' : 'translate-y-1.5 opacity-0',
        )}
      >
        {step >= 3 && result.winner && (
          <>
            <p className="text-[11px] font-semibold tracking-[0.16em] text-neutral-400 uppercase">
              Winner
            </p>
            <p className="font-heading mt-1 text-2xl leading-tight text-white">
              {result.winner.who}
            </p>
            <p className="mt-1 text-sm text-neutral-400 tabular-nums">
              {num(result.winner_tickets)} of {num(result.total_tickets)}{' '}
              tickets
            </p>
          </>
        )}
      </div>
    </div>
  );
}

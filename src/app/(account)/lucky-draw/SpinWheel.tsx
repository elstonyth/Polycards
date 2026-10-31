'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { num, rmAuto } from '@/lib/format';
import { useSound } from '@/lib/use-sound';
import {
  HOLO_STOPS,
  holoConic,
  landingAngle,
  segmentAt,
  wheelSegments,
  entriesIntact,
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
// At most one pointer tick per this many ms: hundreds of thin wedges racing
// past would otherwise blur into a buzz.
const TICK_GAP_MS = 38;
// The frame's soft glow, in its own foil (violet, then cyan).
const HOLO_FRAME_GLOW = `0 0 60px ${HOLO_STOPS[1]}33, 0 0 120px ${HOLO_STOPS[0]}22`;

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
  const { result, entries, prizes } = detail;
  // A one-winner pot: the hero rises with the next two tucked behind it.
  const fan = prizes?.slice(1, 3) ?? [];
  // An entry list that does not add up cannot be walked: no landing.
  const intact = entriesIntact(entries, result);
  const win = intact ? winnerIndex(entries, detail.ticket_index) : -1;
  const segs = useMemo(() => wheelSegments(entries, win), [entries, win]);
  const winSeg = useMemo(
    () => segs.find((s) => s.index === win) ?? null,
    [segs, win],
  );
  const [step, setStep] = useState<Step>(0);
  // The cues (header mute applies). Read through a ref so a new sfx identity
  // never restarts the spin.
  const { sfx, duck } = useSound();
  const sfxRef = useRef(sfx);
  useEffect(() => {
    sfxRef.current = sfx;
  });
  // The music bed steps back while the wheel is on screen.
  useEffect(() => {
    duck(true);
    return () => duck(false);
  }, [duck]);
  // Reduced motion (even switched on mid-spin) or nothing to land on: the
  // end state, told as is.
  const shown: Step = reduced || !winSeg ? 3 : step;
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
      // No spin under reduced motion, but the winner is still announced.
      sfxRef.current('drawWin');
      return;
    }

    const dust = createHoloDust(canvas);
    const timers: number[] = [];
    const end = WINDUP_MS + MAIN_MS + SETTLE_MS;
    // Timed from the first frame, not the mount: a result that arrives in a
    // hidden tab (rAF paused) still spins on return, cues in order.
    let t0 = -1;
    let raf = 0;
    let last = 0;
    let rotation = 0;
    let lastRot = 0;
    let lastIdx = segmentAt(segs, 0);
    let stopped = false;
    let launched = false;
    let lastTick = 0;
    // The pointer: a damped spring, kicked each time a wedge edge passes.
    let pAngle = 0;
    let pVel = 0;

    const frame = (now: number) => {
      if (t0 < 0) t0 = last = now;
      const t = now - t0;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (t >= WINDUP_MS && !launched) {
        launched = true;
        sfxRef.current('drawStart');
      }
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
        if (now - lastTick >= TICK_GAP_MS) {
          lastTick = now;
          sfxRef.current('drawTick');
        }
      }
      pVel += (-520 * pAngle - 26 * pVel) * dt;
      pAngle += pVel * dt;
      pointer.setAttribute('transform', `rotate(${pAngle} 0 -264)`);

      if (t >= end && !stopped) {
        stopped = true;
        setStep(1);
        dust.burst();
        sfxRef.current('drawStop');
        timers.push(
          window.setTimeout(() => {
            setStep(2);
            dust.wave(); // the second, softer wave off the card's top edge
            sfxRef.current('drawWin');
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
    // Sized by the window's height too, so the whole wheel and Done fit a laptop;
    // the result beside it on a phone on its side.
    <div className="short:grid short:grid-cols-2 short:items-center short:gap-4">
      <div className="relative mx-auto aspect-square w-[min(84vw,26rem,max(14rem,100dvh-19rem))] short:w-[calc(100dvh-7.5rem)]">
        <div
          className={cn(
            'absolute inset-0 transition-[scale,filter] duration-900 ease-[cubic-bezier(.2,.8,.2,1)] motion-reduce:transition-none',
            shown >= 2 && 'scale-86 brightness-38 saturate-80',
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
                    opacity={shown >= 1 ? 0.45 : 0}
                    className="transition-opacity duration-700 motion-reduce:transition-none"
                  />
                  {/* Everything but the winning wedge steps back (evenodd cut). */}
                  <path
                    d={`M-${R} 0 A${R} ${R} 0 1 0 ${R} 0 A${R} ${R} 0 1 0 -${R} 0 Z ${arc(winSeg.a0, winSeg.a1)}`}
                    fill="#000"
                    fillRule="evenodd"
                    opacity={shown >= 1 ? 0.3 : 0}
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
              shown >= 1
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
            shown >= 2
              ? 'opacity-100'
              : 'translate-y-[18px] scale-94 opacity-0',
          )}
        >
          <div className="relative aspect-[5/7] w-[38%]">
            {fan.map((p, i) => (
              <div
                key={i}
                className={cn(
                  'absolute inset-0 scale-90 overflow-hidden rounded-[9px] border border-white/15 bg-[radial-gradient(90%_60%_at_50%_30%,#2a2a2e,#121214_70%)] p-2',
                  i === 0
                    ? '-translate-x-[38%] -rotate-[9deg]'
                    : 'translate-x-[38%] rotate-[9deg]',
                )}
              >
                <span className="relative block h-full w-full">
                  <PrizeArt src={p.image} kind={p.kind} />
                </span>
              </div>
            ))}
            <div
              className="holo-turn absolute inset-0 rounded-[10px] p-[1.5px] [--holo-period:6s]"
              style={{ background: holoConic, boxShadow: HOLO_FRAME_GLOW }}
            >
              <div className="relative h-full w-full overflow-hidden rounded-[9px] bg-[radial-gradient(90%_60%_at_50%_30%,#2a2a2e,#121214_70%)] p-2">
                <span className="relative block h-full w-full">
                  <PrizeArt src={result.image} kind={prizes?.[0]?.kind} />
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div
        aria-live="polite"
        className={cn(
          'mt-4 min-h-20 text-center transition-[opacity,translate] duration-500 short:mt-0 motion-reduce:transition-none',
          shown >= 3 ? 'opacity-100' : 'translate-y-1.5 opacity-0',
        )}
      >
        {shown >= 3 && result.winner && (
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
            {!intact && (
              <p className="mt-1 text-xs text-neutral-400">
                Entry list couldn&rsquo;t be read — refresh.
              </p>
            )}
            {prizes && prizes.length > 0 && (
              <div className="mx-auto mt-4 max-w-xs text-left">
                <p className="flex items-baseline justify-between gap-3 text-[11px] font-semibold tracking-wide text-neutral-400 uppercase">
                  <span>Takes every prize</span>
                  <span className="font-heading text-base tracking-normal text-chase tabular-nums normal-case">
                    {rmAuto(result.value_myr)}
                  </span>
                </p>
                <ul className="mt-1.5 space-y-1">
                  {prizes.map((p, i) => (
                    <li
                      key={i}
                      className="flex items-baseline justify-between gap-3 text-sm text-neutral-200"
                    >
                      <span className="min-w-0 truncate">{p.title}</span>
                      <span className="shrink-0 text-xs text-neutral-400 tabular-nums">
                        {rmAuto(p.value_myr)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

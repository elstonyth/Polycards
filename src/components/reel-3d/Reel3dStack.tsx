'use client';

// The 3D reel (curved strip) as a drop-in for SlotReelStack: same props, same
// settle contract (each reel reports its winner rect, then onAllSettled fires
// once after the last one). The DOM reel renders first (server HTML, and every
// device the gate keeps flat); the canvas takes over only once its art is
// drawn and the machine is idle, and hands back to the DOM reel for good if
// the GPU context dies. three.js loads only on devices that pass the gate.
import { useEffect, useRef, useState, type ComponentProps } from 'react';
import { SlotReelStack } from '@/app/slots/[slug]/SlotReelStack';
import { browserGateEnv, gateStage } from '@/components/pack-stage/stage-gate';
import { readCrashFlag } from '@/components/pack-stage/crash-guard';
import type { ReelEngine } from './engine';

type Props = ComponentProps<typeof SlotReelStack>;

/** Room above and below the stack for the landed winner's bloom. */
const BLEED = 48;

export function Reel3dStack(props: Props) {
  const {
    count,
    spinKey,
    winners,
    reduced,
    cellSize = 96,
    decoyPools,
    hideWinners = false,
  } = props;
  const hostRef = useRef<HTMLDivElement>(null);
  const [engine, setEngine] = useState<ReelEngine | null>(null);
  const [ready, setReady] = useState(false);
  const [lost, setLost] = useState(false);
  const [show3d, setShow3d] = useState(false);
  const live = useRef(props);
  const settledRef = useRef(0);
  const spunRef = useRef<number | 'idle'>('idle');
  useEffect(() => {
    live.current = props;
  });

  // Gate, then load and start the engine (client only, never on the server).
  useEffect(() => {
    const host = hostRef.current;
    if (!host || reduced) return;
    if (gateStage(browserGateEnv(), { crashFlag: readCrashFlag() }) === 'flat')
      return;
    let disposed = false;
    let made: ReelEngine | null = null;
    import('./engine').then(
      ({ ReelEngine }) => {
        if (disposed) return;
        made = ReelEngine.create({
          host,
          reduced,
          onCellCross: () => live.current.onCellCross?.(),
          onReelSettled: (reel, rect) => {
            live.current.onWinnerRect?.(reel, rect);
            settledRef.current += 1;
            if (settledRef.current === live.current.count)
              live.current.onAllSettled?.();
          },
          onReady: () => setReady(true),
          onLost: () => setLost(true),
        });
        setEngine(made);
      },
      () => {
        // Chunk failed to load: the DOM reel stays.
      },
    );
    return () => {
      disposed = true;
      made?.dispose();
      setEngine(null);
      setReady(false);
    };
  }, [reduced]);

  useEffect(() => {
    engine?.configure(count, cellSize);
  }, [engine, count, cellSize]);

  useEffect(() => {
    if (engine && decoyPools) engine.setPools(decoyPools);
  }, [engine, decoyPools]);

  // Take over from the DOM reel only between spins, so no spin changes hands.
  const idle = winners === null;
  // Adjusted while rendering (same pattern as the spin page's cellSize).
  if (ready && idle && !lost && !show3d) setShow3d(true);
  const on3d = show3d && !lost && engine !== null;

  // Spin when the winners arrive (as the DOM reel does); idle when they clear.
  useEffect(() => {
    if (!engine || !on3d) return;
    if (winners && spinKey !== 'idle' && spunRef.current !== spinKey) {
      spunRef.current = spinKey;
      settledRef.current = 0;
      engine.spinNow(winners, spinKey);
    } else if (!winners) {
      spunRef.current = 'idle';
      engine.release();
    }
  }, [engine, on3d, winners, spinKey]);

  useEffect(() => {
    engine?.setHideWinners(hideWinners);
    // The reveal covers the machine from transform on: stop drawing it.
    engine?.setPaused(hideWinners);
  }, [engine, hideWinners]);

  return (
    <div
      className="relative w-full [--reel-gap:12px] sm:[--reel-gap:16px]"
      style={{
        height: `calc(${count} * ${cellSize + 16}px + ${count - 1} * var(--reel-gap))`,
      }}
    >
      {!on3d && <SlotReelStack {...props} />}
      <div
        ref={hostRef}
        aria-hidden
        className="pointer-events-none absolute inset-x-0"
        style={{
          top: -BLEED,
          bottom: -BLEED,
          visibility: on3d ? 'visible' : 'hidden',
        }}
      />
    </div>
  );
}

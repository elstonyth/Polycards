'use client';

import dynamic from 'next/dynamic';
import {
  Component,
  useCallback,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import { usePrefersReducedMotion } from '@/lib/use-reveal';
import { StaticCoin } from './StaticCoin';
import styles from './coin-flip.module.css';
import type { CoinGesture } from '@/lib/coin-motion';
import type { CoinSide } from '@/lib/coin-flip';

export type CoinSceneProps = {
  armed: boolean;
  // The toss is committed and waiting for the server's result.
  pending: boolean;
  outcome: 'won' | 'lost' | null;
  side: CoinSide;
  playbackId: string | null;
  profile: CoinGesture;
  onFlick: (profile: CoinGesture) => void;
  onComplete: () => void;
  onReadyChange: (ready: boolean) => void;
  // The result is on screen: the coin lights up for a win, dims for a loss.
  revealed: boolean;
};
// The still coin (reduced motion, loading, no WebGL) marks the result too.
function ResultCoin({ side, outcome, revealed }: CoinSceneProps) {
  return (
    <span
      className={
        revealed && outcome
          ? outcome === 'won'
            ? styles.staticWin
            : styles.staticLoss
          : undefined
      }
    >
      <StaticCoin side={side} />
    </span>
  );
}
function Fallback(props: CoinSceneProps) {
  const { onReadyChange } = props;
  useEffect(() => onReadyChange(false), [onReadyChange]);
  return (
    <div
      role="img"
      aria-label={`${props.side === 'head' ? 'Head' : 'Tail'} ${props.outcome ? 'landed.' : 'selected. Use the Flip coin button after confirming cards.'}`}
      className="flex h-full items-center justify-center bg-neutral-950"
    >
      <ResultCoin {...props} />
    </div>
  );
}
const Scene = dynamic(() => import('./CoinScene').then((m) => m.CoinScene), {
  ssr: false,
  loading: () => null,
});
class SceneBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
export function CoinStage(props: CoinSceneProps) {
  const reduced = usePrefersReducedMotion();
  const [ready, setReady] = useState(false);
  const { playbackId, onComplete, onReadyChange } = props;
  const reportReady = useCallback(
    (value: boolean) => {
      setReady(value);
      onReadyChange(value);
    },
    [onReadyChange],
  );
  useEffect(() => {
    // A settled flip must stay readable even while the renderer or its assets load.
    if ((reduced || !ready) && playbackId) onComplete();
  }, [reduced, ready, playbackId, onComplete]);
  const side = props.side === 'head' ? 'Head' : 'Tail';
  return reduced ? (
    <Fallback {...props} onReadyChange={reportReady} />
  ) : (
    <SceneBoundary
      fallback={<Fallback {...props} onReadyChange={reportReady} />}
    >
      <div
        role="img"
        aria-label={
          playbackId && ready
            ? 'Coin in flight.'
            : props.outcome
              ? `${side} landed.`
              : `${side} selected. ${props.armed && ready ? 'Drag upward and release to toss, or use Flip coin.' : 'Use the Flip coin button after confirming cards.'}`
        }
        className="relative h-full bg-neutral-950"
      >
        <div
          aria-hidden
          className={`absolute inset-0 ${ready ? '' : 'invisible'}`}
        >
          <Scene {...props} onReadyChange={reportReady} />
        </div>
        {!ready && (
          <div className="absolute inset-0 flex items-center justify-center">
            <ResultCoin {...props} />
          </div>
        )}
      </div>
    </SceneBoundary>
  );
}

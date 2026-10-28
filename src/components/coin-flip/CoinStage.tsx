'use client';

import dynamic from 'next/dynamic';
import { Component, useEffect, type ReactNode } from 'react';
import { usePrefersReducedMotion } from '@/lib/use-reveal';
import { StaticCoin } from './StaticCoin';
import type { CoinGesture } from '@/lib/coin-motion';

export type CoinSceneProps = {
  armed: boolean;
  outcome: 'won' | 'lost' | null;
  playbackId: string | null;
  profile: CoinGesture;
  onFlick: (profile: CoinGesture) => void;
  onComplete: () => void;
};
function Fallback(props: CoinSceneProps) {
  const { playbackId, onComplete } = props;
  useEffect(() => {
    if (playbackId) onComplete();
  }, [playbackId, onComplete]);
  return (
    <div className="flex h-72 items-center justify-center bg-neutral-950 sm:h-[400px]">
      <StaticCoin won={props.outcome !== 'lost'} />
    </div>
  );
}
const Scene = dynamic(() => import('./CoinScene').then((m) => m.CoinScene), {
  ssr: false,
  loading: () => (
    <div className="flex h-72 items-center justify-center bg-neutral-950 sm:h-[400px]">
      <StaticCoin />
    </div>
  ),
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
  return reduced ? (
    <Fallback {...props} />
  ) : (
    <SceneBoundary fallback={<Fallback {...props} />}>
      <Scene {...props} />
    </SceneBoundary>
  );
}

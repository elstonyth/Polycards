'use client';

import { createContext, useContext, useState, type ReactNode } from 'react';

/**
 * The equipped avatar frame, shared between the /me header and the Edit
 * Profile modal so equipping a frame updates the header avatar instantly
 * WITHOUT a router.refresh() — the full-page refetch is what blew the
 * per-actor read budget during rapid swapping (2026-07-07 round 2).
 *
 * Its own module (not MeAppearance.tsx) so the header and the modal can both
 * import it without an import cycle.
 */
const EquippedFrameContext = createContext<{
  equipped: number | null;
  setEquipped: (level: number | null) => void;
} | null>(null);

export function EquippedFrameProvider({
  initial,
  children,
}: {
  initial: number | null;
  children: ReactNode;
}) {
  const [equipped, setEquipped] = useState(initial);
  // Server prop changed (real navigation/refresh) — resync during render,
  // the React-sanctioned pattern for prop-driven state adjustment.
  const [prev, setPrev] = useState(initial);
  if (prev !== initial) {
    setPrev(initial);
    setEquipped(initial);
  }
  return (
    <EquippedFrameContext.Provider value={{ equipped, setEquipped }}>
      {children}
    </EquippedFrameContext.Provider>
  );
}

export function useEquippedFrame() {
  const ctx = useContext(EquippedFrameContext);
  if (!ctx) {
    throw new Error('useEquippedFrame requires <EquippedFrameProvider>');
  }
  return ctx;
}

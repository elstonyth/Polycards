import { useCallback, useEffect, useState } from 'react';

/** The longest the flow is waited for before Just Pulled stops waiting. */
export const FLOW_WAIT_CAP_MS = 15_000;

/**
 * Whether the flow is still on its way ('pending', until the spin chunk has
 * bound) or will not come ('gave-up'); null once the flow's own switch decides.
 */
export type FlowWait = 'pending' | 'gave-up' | null;

/**
 * The wait for the flow: pending at mount, given up when the spin chunk fails
 * or has not bound within FLOW_WAIT_CAP_MS, and handed to the flow when it
 * binds (even after the cap).
 */
export function useFlowWait(): {
  wait: FlowWait;
  bound(): void;
  failed(): void;
} {
  const [wait, setWait] = useState<FlowWait>('pending');
  useEffect(() => {
    const t = setTimeout(
      () => setWait((w) => (w === 'pending' ? 'gave-up' : w)),
      FLOW_WAIT_CAP_MS,
    );
    return () => clearTimeout(t);
  }, []);
  const bound = useCallback(() => setWait(null), []);
  const failed = useCallback(() => setWait('gave-up'), []);
  return { wait, bound, failed };
}

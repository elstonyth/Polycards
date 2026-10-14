import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { qk } from '../../lib/query-keys';
import { LIVE_MS } from './helpers';

// Every list the Dashboard reads, by prefix. Invalidating a prefix refetches
// only the queries mounted right now (the Dashboard's own), and the other
// pages' cached views are just marked stale.
const LIVE_KEYS: readonly (readonly unknown[])[] = [
  ['admin', 'stats'],
  ['admin', 'gateway-settlement'],
  qk.gatewayWithdrawalsKey,
  ['admin', 'gateway-deposits'],
  qk.deliveryOrdersKey,
  qk.referralSettlements,
];

/**
 * Keeps the Dashboard live without a push channel (none exists, and the
 * redesign adds no backend): refetch everything every LIVE_MS while the tab
 * is visible, and once more as soon as it becomes visible again.
 */
export const useLiveRefresh = (): void => {
  const queryClient = useQueryClient();
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState !== 'visible') return;
      for (const queryKey of LIVE_KEYS) {
        void queryClient.invalidateQueries({ queryKey });
      }
    };
    const timer = window.setInterval(refresh, LIVE_MS);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [queryClient]);
};

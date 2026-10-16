import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { qk } from '../../lib/query-keys';
import { LIVE_MS } from './helpers';

// Every list the Dashboard reads, by prefix. Invalidating a prefix refetches
// only the queries mounted right now (the Dashboard's own), and the other
// pages' cached views are just marked stale.
//
// The queues behind the attention alert also refresh in a background tab
// (browsers slow the timer to about once a minute there), so the sound and the
// tab-title count reach an operator working in another tab. The heavier report
// panels wait until the tab is visible again.
const QUEUE_KEYS: readonly (readonly unknown[])[] = [
  qk.gatewayWithdrawalsKey,
  ['admin', 'gateway-deposits'],
  qk.deliveryOrdersKey,
  qk.referralSettlements,
  qk.pricingHealth,
];
const LIVE_KEYS: readonly (readonly unknown[])[] = [
  ['admin', 'stats'],
  ['admin', 'gateway-settlement'],
  qk.profitReportKey,
  ...QUEUE_KEYS,
];

/**
 * Keeps the Dashboard live without a push channel (none exists, and the
 * redesign adds no backend): refetch everything every LIVE_MS while the tab
 * is visible (only the queues while hidden), and everything once more as soon
 * as it becomes visible again.
 */
export const useLiveRefresh = (): void => {
  const queryClient = useQueryClient();
  useEffect(() => {
    const refresh = () => {
      const visible = document.visibilityState === 'visible';
      for (const queryKey of visible ? LIVE_KEYS : QUEUE_KEYS) {
        void queryClient.invalidateQueries({ queryKey });
      }
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    const timer = window.setInterval(refresh, LIVE_MS);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [queryClient]);
};

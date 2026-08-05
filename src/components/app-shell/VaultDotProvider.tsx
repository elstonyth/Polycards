'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { getVaultLatest } from '@/lib/actions/vault';
import { useAuth } from '@/components/auth/AuthProvider';
import { seenKey, shouldShowDot } from '@/lib/vault-dot';

type VaultDotContextValue = {
  /** Newest vault event, ISO. Null while loading, logged out, or empty. */
  latestAt: string | null;
  /** True when the vault holds something unseen. Always false before mount. */
  show: boolean;
  /** Mark everything up to `latestAt` seen. No-op until `latestAt` resolves. */
  markSeen: () => void;
};

const VaultDotContext = createContext<VaultDotContextValue | null>(null);

export function useVaultDot(): VaultDotContextValue {
  const ctx = useContext(VaultDotContext);
  if (!ctx) throw new Error('useVaultDot must be used within VaultDotProvider');
  return ctx;
}

// Focus refetches are throttled to one per this window per session. The
// 2026-07-07 incident was a sustained store-read ceiling from exactly this kind
// of chrome fan-out; a full page load is never throttled, only focus events.
const REFETCH_TTL_MS = 30_000;

function readStamp(customerId: string): string | null {
  try {
    return window.localStorage.getItem(seenKey(customerId));
  } catch {
    // Safari private mode throws on access. No stamp → the dot shows, which is
    // the harmless direction.
    return null;
  }
}

function writeStamp(customerId: string, at: string): void {
  try {
    window.localStorage.setItem(seenKey(customerId), at);
  } catch {
    // Storage unavailable — the dot stays lit for this session. Not worth
    // surfacing to the customer over a nav hint.
  }
}

/**
 * Holds the Vault tab's unread-dot state. Separate from TopUpProvider (which
 * owns money) because this is a nav hint with its own refresh cadence.
 *
 * State is stored WITH the customer id it was fetched for and only renders when
 * that id still matches — the same defence TopUpProvider added after an
 * untagged balance leaked the previous user's amount across a logout→login.
 */
export function VaultDotProvider({ children }: { children: ReactNode }) {
  const { customer } = useAuth();
  const [state, setState] = useState<{
    forId: string;
    latestAt: string | null;
    seenAt: string | null;
  } | null>(null);
  const lastFetchRef = useRef(0);
  // Monotonic request id. Every fetch claims one and only writes if it is still
  // the newest — so a slow response that lands after an account switch, or
  // after a later refresh already answered, is dropped instead of clobbering
  // fresher state. One mechanism serves BOTH callers below.
  const genRef = useRef(0);

  const refresh = useCallback(async (forId: string) => {
    const gen = ++genRef.current;
    // Stamped BEFORE the await, not after: an event landing while this fetch is
    // still in flight would otherwise read a stale timestamp, pass the TTL
    // check, and fire a duplicate request.
    lastFetchRef.current = Date.now();
    const latestAt = await getVaultLatest();
    if (gen !== genRef.current) return;
    setState((prev) => ({
      forId,
      latestAt,
      // Keep an in-session markSeen; only consult storage on the first load for
      // this identity, so a refresh can't resurrect a dot already cleared.
      seenAt: prev?.forId === forId ? prev.seenAt : readStamp(forId),
    }));
  }, []);

  // Fetch on login / account switch.
  //
  // This inlines the fetch rather than calling refresh(), and that is forced,
  // not stylistic: react-hooks/set-state-in-effect traces through a called
  // function, so `void refresh(customer.id)` here is rejected exactly like a
  // bare setState would be, even though refresh only writes after an await. The
  // setState has to sit lexically inside a callback in the effect body. Both
  // paths still share genRef, so the drop-if-superseded rule lives in one place.
  //
  // Logging out writes no state at all: `live` below derives to null whenever
  // `customer` is null, so a signed-out shell can never render the previous
  // account's dot even though the stale value is still in memory.
  useEffect(() => {
    if (!customer) return;
    const forId = customer.id;
    const gen = ++genRef.current;
    lastFetchRef.current = Date.now();
    void getVaultLatest().then((latestAt) => {
      if (gen !== genRef.current) return;
      setState((prev) => ({
        forId,
        latestAt,
        seenAt: prev?.forId === forId ? prev.seenAt : readStamp(forId),
      }));
    });
  }, [customer]);

  // Refresh when the tab regains focus, throttled — mirrors NotificationBell's
  // cadence without its unthrottled refetch.
  useEffect(() => {
    if (!customer) return;
    const forId = customer.id;
    const onFocus = () => {
      if (Date.now() - lastFetchRef.current < REFETCH_TTL_MS) return;
      void refresh(forId);
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [customer, refresh]);

  const markSeen = useCallback(() => {
    setState((prev) => {
      if (!prev?.latestAt) return prev;
      writeStamp(prev.forId, prev.latestAt);
      return { ...prev, seenAt: prev.latestAt };
    });
  }, []);

  // Cross-identity state derives away rather than rendering. Also covers SSR
  // and the pre-fetch beat: `state` is null there, so `show` is false and no
  // dot is emitted before mount (localStorage does not exist server-side, and
  // rendering one earlier would be a hydration mismatch).
  const live = customer && state?.forId === customer.id ? state : null;

  return (
    <VaultDotContext.Provider
      value={{
        latestAt: live?.latestAt ?? null,
        show: live ? shouldShowDot(live.latestAt, live.seenAt) : false,
        markSeen,
      }}
    >
      {children}
    </VaultDotContext.Provider>
  );
}

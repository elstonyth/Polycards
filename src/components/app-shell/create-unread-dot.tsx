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
import { useAuth } from '@/components/auth/AuthProvider';
import { seenKey, shouldShowDot, type DotScope } from '@/lib/unread-dot';

export type UnreadDot = {
  /** Newest event on this surface, ISO. Null while loading, logged out, empty. */
  latestAt: string | null;
  /** True when the surface holds something unseen. Always false before mount. */
  show: boolean;
  /** Mark everything up to `latestAt` seen. No-op until `latestAt` resolves. */
  markSeen: () => void;
  /** Re-read now, bypassing the focus throttle — for callers that KNOW. */
  refresh: () => void;
};

// Focus refetches are throttled to one per this window per session. The
// 2026-07-07 incident was a sustained store-read ceiling from exactly this kind
// of chrome fan-out.
const REFETCH_TTL_MS = 30_000;

function readStamp(scope: DotScope, customerId: string): string | null {
  try {
    return window.localStorage.getItem(seenKey(scope, customerId));
  } catch {
    // Safari private mode throws on access. No stamp → the dot shows, which is
    // the harmless direction.
    return null;
  }
}

function writeStamp(scope: DotScope, customerId: string, at: string): void {
  try {
    window.localStorage.setItem(seenKey(scope, customerId), at);
  } catch {
    // Storage unavailable — the dot stays lit for this session. Not worth
    // surfacing to the customer over a nav hint.
  }
}

/**
 * Builds one unread-dot provider + hook pair.
 *
 * Both dots need identical mechanics — identity tagging, a monotonic
 * drop-if-superseded rule, a throttled focus refresh, an explicit refresh for
 * callers that just caused the event. That logic is subtle enough (see the
 * comments below, each of which is a bug someone already hit) that having two
 * copies drift apart is the real risk, so it lives here once.
 *
 * `fetchLatest` returns the surface's newest event as an ISO string, or null
 * for "nothing / logged out / the read failed". Both callers below still guard
 * against rejection: these are Server Actions, so the action CALL is a network
 * round-trip that can reject on its own (offline, a 5xx from the action
 * endpoint, a deployment-id mismatch) no matter how well the action body
 * catches. A rejected mount read would otherwise leave state null and the dot
 * dead for the whole session, silently.
 */
export function createUnreadDot(
  scope: DotScope,
  fetchLatest: () => Promise<string | null>,
) {
  const Ctx = createContext<UnreadDot | null>(null);

  function useDot(): UnreadDot {
    const ctx = useContext(Ctx);
    if (!ctx) {
      throw new Error(`the ${scope} dot must be used within its provider`);
    }
    return ctx;
  }

  function Provider({ children }: { children: ReactNode }) {
    const { customer } = useAuth();
    // Stored WITH the customer it was fetched for and only rendered when that
    // id still matches — the defence TopUpProvider added after an untagged
    // balance leaked the previous user's amount across a logout→login.
    const [state, setState] = useState<{
      forId: string;
      latestAt: string | null;
      seenAt: string | null;
    } | null>(null);
    const lastFetchRef = useRef(0);
    // Monotonic request id. Every fetch claims one and only writes if it is
    // still the newest — so a slow response landing after an account switch, or
    // after a later refresh already answered, is dropped instead of clobbering
    // fresher state.
    const genRef = useRef(0);
    // Coalesces a burst. Selling back N cards fires N applyBalance calls, and
    // each would otherwise be its own round trip. Skipping outright could miss
    // the last write, so a request arriving mid-flight sets `trailingRef` and
    // the in-flight one re-runs once when it lands — at most two reads per
    // burst, and the second always sees the final state.
    const inFlightRef = useRef(false);
    const trailingRef = useRef(false);

    const refresh = useCallback(async (forId: string) => {
      if (inFlightRef.current) {
        trailingRef.current = true;
        return;
      }
      inFlightRef.current = true;
      // finally, not a plain assignment at the end: every exit below is an
      // early return, and stranding this flag would freeze the dot for the
      // rest of the session.
      try {
        do {
          trailingRef.current = false;
          const gen = ++genRef.current;
          // Stamped BEFORE the await: an event landing while this fetch is
          // still in flight would otherwise read a stale timestamp, pass the
          // TTL check, and fire a duplicate request.
          lastFetchRef.current = Date.now();
          let latestAt: string | null;
          try {
            latestAt = await fetchLatest();
          } catch {
            return; // keep what we last knew rather than blanking the dot
          }
          if (gen !== genRef.current) return;
          setState((prev) => ({
            forId,
            latestAt,
            // Keep an in-session markSeen; only consult storage on the first
            // load for this identity, so a refresh can't resurrect a cleared
            // dot.
            seenAt:
              prev?.forId === forId ? prev.seenAt : readStamp(scope, forId),
          }));
        } while (trailingRef.current);
      } finally {
        inFlightRef.current = false;
      }
    }, []);

    // Fetch on login / account switch.
    //
    // This inlines the fetch rather than calling refresh(), and that is forced,
    // not stylistic: react-hooks/set-state-in-effect traces through a called
    // function, so `void refresh(customer.id)` here is rejected exactly like a
    // bare setState, even though refresh only writes after an await. The
    // setState has to sit lexically inside a callback in the effect body. Both
    // paths still share genRef, so the drop rule lives in one place.
    //
    // Logging out writes no state at all: `live` below derives to null whenever
    // `customer` is null, so a signed-out shell can never render the previous
    // account's dot even though the stale value is still in memory.
    useEffect(() => {
      if (!customer) return;
      const forId = customer.id;
      const gen = ++genRef.current;
      lastFetchRef.current = Date.now();
      void fetchLatest()
        .catch(() => null)
        .then((latestAt) => {
          if (gen !== genRef.current) return;
          setState((prev) => ({
            forId,
            latestAt,
            seenAt:
              prev?.forId === forId ? prev.seenAt : readStamp(scope, forId),
          }));
        });
    }, [customer]);

    // Refresh when the tab regains focus, throttled.
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
        writeStamp(scope, prev.forId, prev.latestAt);
        return { ...prev, seenAt: prev.latestAt };
      });
    }, []);

    // Deliberately NOT throttled: the focus handler guesses that something may
    // have changed, so it pays the TTL; a caller reaching for this has just
    // watched the event happen and is telling us so.
    const refreshNow = useCallback(() => {
      if (!customer) return;
      void refresh(customer.id);
    }, [customer, refresh]);

    // Cross-identity state derives away rather than rendering. Also covers SSR
    // and the pre-fetch beat: `state` is null there, so `show` is false and no
    // dot is emitted before mount (localStorage does not exist server-side, and
    // rendering one earlier would be a hydration mismatch).
    const live = customer && state?.forId === customer.id ? state : null;

    return (
      <Ctx.Provider
        value={{
          latestAt: live?.latestAt ?? null,
          show: live ? shouldShowDot(live.latestAt, live.seenAt) : false,
          markSeen,
          refresh: refreshNow,
        }}
      >
        {children}
      </Ctx.Provider>
    );
  }

  return { Provider, useDot };
}

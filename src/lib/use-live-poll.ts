'use client';

import { useEffect, useRef, useState } from 'react';

/** Read a same-origin JSON endpoint; `null` for any non-2xx (the caller keeps
 *  its last good data). `cache: 'no-store'` because every caller is polling for
 *  freshness — a cached answer defeats the point. */
async function fetchJsonDefault(url: string): Promise<unknown> {
  const res = await fetch(url, { cache: 'no-store' });
  return res.ok ? ((await res.json()) as unknown) : null;
}

export type LivePollOptions<T> = {
  intervalMs: number;
  /** Identifies the scope `data` belongs to (a pack slug, a card handle, a
   *  pack|tier pair). Changing it does NOT clear `data` — it flips `pending`
   *  until a response for the new key lands. A caller that wants a clean slate
   *  renders its own `initial` while `pending` (see usePackDetailPoll); one
   *  that wants the previous scope's rows to stay on screen renders `data`
   *  (see useLiveRecentPulls). Omit it and `pending` is always false. */
  resetKey?: string;
  /** Turn a payload into the next state, or `null` to keep `prev`. `pending`
   *  is true when nothing has landed for the current `resetKey` yet, which is
   *  how recent-pulls tells "an empty feed for a NEW scope" (an honest empty
   *  state) from "an empty feed for the scope already on screen" (a blip).
   *  NOTE: because `null` means keep-prev, an `accept` can never *write* null —
   *  fine for every caller here, whose payloads are objects. */
  accept?: (next: unknown, prev: T, pending: boolean) => T | null;
  /** Injected by tests; defaults to fetch → json, `null` on a non-2xx. */
  fetchJson?: (url: string) => Promise<unknown>;
};

export type LivePoll<T> = {
  data: T;
  /** `shownKey !== resetKey` — no response for the current scope yet. */
  pending: boolean;
  /** The `resetKey` the data on screen belongs to. Changes exactly when a new
   *  scope's data lands, so a list keyed on it re-enters once. */
  shownKey: string;
};

/**
 * The storefront's one polling loop: seed from server data, refresh on an
 * interval while the tab is visible, refetch the moment a backgrounded tab
 * comes back, and never blank on a transient failure.
 *
 * Invariants:
 *  - `url: null` polls nothing (no interval, no listener).
 *  - A hidden tab never fires — the gate is inside the tick, so mounting while
 *    hidden fetches nothing and self-heals on the first `visibilitychange`.
 *  - A response that arrives after a newer one never writes (ticks overlap: a
 *    visibility refetch can land under a slow interval tick).
 *  - A failed fetch, a non-2xx, or an `accept` returning `null` keeps `data`.
 */
export function useLivePoll<T>(
  url: string | null,
  initial: T,
  { intervalMs, resetKey = '', accept, fetchJson }: LivePollOptions<T>,
): LivePoll<T> {
  const [data, setData] = useState(initial);
  const [shownKey, setShownKey] = useState(resetKey);
  // Refs are what the async tick reads; the state above is what renders. A
  // second tick in the same effect run (mount + a visibility refetch) must see
  // the first one's write, which the state mirror in its closure cannot show.
  const shownRef = useRef(resetKey);
  const dataRef = useRef(initial);
  // Monotonic request id: only the newest may write, or an older response
  // would roll the data back.
  const revRef = useRef(0);
  // Latest-ref for the callbacks so an inline `accept` (a new function every
  // render) doesn't restart the interval on every render.
  const acceptRef = useRef(accept);
  const fetchRef = useRef(fetchJson);
  useEffect(() => {
    acceptRef.current = accept;
    fetchRef.current = fetchJson;
  });

  useEffect(() => {
    if (!url) return;
    let active = true;
    const tick = async () => {
      // Hidden/background tabs would poll forever otherwise.
      if (document.visibilityState !== 'visible') return;
      const rev = ++revRef.current;
      try {
        const payload = await (fetchRef.current ?? fetchJsonDefault)(url);
        if (!active || rev !== revRef.current || payload == null) return;
        const next = acceptRef.current
          ? acceptRef.current(
              payload,
              dataRef.current,
              shownRef.current !== resetKey,
            )
          : (payload as T);
        if (next === null) return;
        dataRef.current = next;
        shownRef.current = resetKey;
        setData(next);
        setShownKey(resetKey);
      } catch {
        // keep the last good data on a transient failure
      }
    };
    void tick(); // swap in live data immediately, then keep polling
    const id = setInterval(tick, intervalMs);
    // Refocusing a backgrounded tab refetches right away — ticks skipped while
    // hidden would otherwise leave the data stale until the next interval.
    const onVisible = () => {
      if (document.visibilityState === 'visible') void tick();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      active = false;
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [url, resetKey, intervalMs]);

  return { data, pending: shownKey !== resetKey, shownKey };
}

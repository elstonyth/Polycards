'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { usePathname, useRouter } from 'next/navigation';
import type { FlowLocation } from './types';

/**
 * The flow's address (plan-step2 section 1 "URLs" and section 3).
 *
 * | Moment | Address |
 * |---|---|
 * | Carousel | `basePath` (`/`) |
 * | Focus from the carousel | `pushState` to `/slots/<id>` (`?count=n` above 1), marked `{ __flow: entryId }` |
 * | Any chapter | unchanged (nothing writes history per scroll frame) |
 * | Unfocus | back to `basePath` |
 * | Anything else (a card overlay puts `/card/...` there) | `other`: the caller keeps its state |
 *
 * `leave()`: when the focus entry is OURS (pushed by `enter` in this document),
 * `history.back()`, so Back and "All packs" are one move and the history has
 * no extra entry. Otherwise (a cold-loaded pack page, a reload, a link in) the
 * flow marks the arrival (the float-in, section 10.10) and pushes `basePath`.
 *
 * `enterReel(href)` is the ONE reel seam (section 1 "Reel"): plain navigation
 * today; the cinematic curtain, when it resumes, wraps it and nothing else.
 *
 * The quantity is read from `location.search` in an effect (and on Back /
 * Forward), never through Next's search-params hook, so the flow can sit on
 * the route-cached `/`.
 *
 * Entry ids live in this document's memory only. A reload or another tab never
 * finds its id here, which is what makes such an entry "not ours".
 */

/** The marker `enter` writes into the history entry's state. */
export const FLOW_MARK = '__flow';

const ours = new Set<string>();

/** The pack a path names, or null (same rule as PackPage's `packSlugOf`). */
export function flowSlugOf(pathname: string): string | null {
  const match = /^\/slots\/([^/]+)\/?$/.exec(pathname);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

const trimSlash = (p: string) => (p.length > 1 ? p.replace(/\/+$/, '') : p);

/** Pathname -> where the flow is. */
export function flowLocationOf(
  pathname: string,
  basePath: string,
): FlowLocation {
  if (trimSlash(pathname) === trimSlash(basePath)) return { kind: 'stage' };
  const id = flowSlugOf(pathname);
  return id ? { kind: 'focus', id } : { kind: 'other' };
}

/** The flow marker on the current history entry, if any. */
export function currentEntryId(): string | null {
  const state: unknown = window.history.state;
  if (state && typeof state === 'object' && FLOW_MARK in state) {
    const id = (state as Record<string, unknown>)[FLOW_MARK];
    return typeof id === 'string' ? id : null;
  }
  return null;
}

const readCount = (): number | null => {
  const raw = new URLSearchParams(window.location.search).get('count');
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isInteger(n) ? Math.min(3, Math.max(1, n)) : null;
};

// The entry as one primitive snapshot ("<id>|<count>"), so the external store
// compares by value.
const listeners = new Set<() => void>();
const notify = () => {
  for (const l of listeners) l();
};
function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener('popstate', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('popstate', listener);
  };
}
const readEntry = (): string =>
  `${currentEntryId() ?? ''}|${readCount() ?? ''}`;
const serverEntry = (): string => '|';
function parseEntry(snapshot: string): {
  id: string | null;
  count: number | null;
} {
  const [id = '', count = ''] = snapshot.split('|');
  return { id: id || null, count: count ? Number(count) : null };
}

const newEntryId = () =>
  `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

export type FlowAddressOptions = {
  /** Marks the float-in arrival before a soft navigation to `basePath` from
   *  a focus entry that is not ours (WP-D's `stage-arrival.ts` `markArrival`;
   *  the integration passes it). Default: nothing. */
  markArrival?: () => void;
};

export type FlowAddress = {
  location: FlowLocation;
  /** The current entry's flow id (null on a cold load / not ours). Restores
   *  the chapter from sessionStorage (FlowChapters). */
  entryId: string | null;
  /** True when the current entry was pushed by `enter` in this document. */
  isOurs: boolean;
  /** `?count=` of the address, clamped 1 to 3; null when absent or junk. */
  count: number | null;
  enter: (id: string, qty?: number) => void;
  leave: () => void;
  enterReel: (href: string) => void;
};

export function useFlowAddress(
  basePath: string,
  { markArrival }: FlowAddressOptions = {},
): FlowAddress {
  const router = useRouter();
  const pathname = usePathname() ?? basePath;
  const location = useMemo(
    () => flowLocationOf(pathname, basePath),
    [pathname, basePath],
  );
  // The last non-"other" place, kept while a card overlay owns the address.
  const [kept, setKept] = useState<FlowLocation>(location);
  if (location.kind !== 'other' && !sameLocation(location, kept)) {
    setKept(location);
  }

  // History state and search are browser-only: none on the server and at
  // hydration (so the server HTML never depends on them), then read from the
  // live entry on every render and on Back / Forward / our own push.
  const snapshot = useSyncExternalStore(subscribe, readEntry, serverEntry);
  const entry = useMemo(() => parseEntry(snapshot), [snapshot]);

  const markRef = useRef(markArrival);
  useEffect(() => {
    markRef.current = markArrival;
  });

  const enter = useCallback((id: string, qty = 1) => {
    const entryId = newEntryId();
    ours.add(entryId);
    const q =
      Number.isInteger(qty) && qty > 1 ? `?count=${Math.min(3, qty)}` : '';
    window.history.pushState(
      { [FLOW_MARK]: entryId },
      '',
      `/slots/${encodeURIComponent(id)}${q}`,
    );
    notify();
  }, []);

  const leave = useCallback(() => {
    const id = currentEntryId();
    if (id !== null && ours.has(id)) {
      window.history.back();
      return;
    }
    markRef.current?.();
    router.push(basePath);
  }, [router, basePath]);

  const enterReel = useCallback(
    (href: string) => {
      router.push(href);
    },
    [router],
  );

  return {
    location: location.kind === 'other' ? kept : location,
    entryId: entry.id,
    isOurs: entry.id !== null && ours.has(entry.id),
    count: entry.count,
    enter,
    leave,
    enterReel,
  };
}

function sameLocation(a: FlowLocation, b: FlowLocation): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind !== 'focus' || (b.kind === 'focus' && a.id === b.id);
}

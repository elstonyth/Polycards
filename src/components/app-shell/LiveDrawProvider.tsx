'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { usePathname } from 'next/navigation';
import { useAuth } from '@/components/auth/AuthProvider';
import { ArenaBoundary } from '@/components/draw-arena/ArenaBoundary';
import { ArenaShow } from '@/components/draw-arena/lazy';
import { getLuckyDrawEventResult } from '@/lib/actions/lucky-draw';
import { readLuckyDrawStatus } from '@/lib/lucky-draw-status-read';
import { POOL_TITLE } from '@/lib/lucky-draw';
import {
  batchWaitUntil,
  cornerLift,
  drawMinute,
  dueGate,
  freshShows,
  LIVE_MAX_AGE_MS,
  mergeWatched,
  nextLookAt,
  nextWake,
  placeShow,
  QUEUE_MAX_AGE_MS,
  readShownDraws,
  recordShownDraw,
  type WatchedGate,
} from '@/lib/lucky-draw-watch';
import type { LuckyDrawResultDetail } from '@/lib/data/schemas';
import { useConsent } from '@/lib/use-consent';

// A pack rip is paid for and has the player's whole attention: wait for it to end.
const SPIN_ROUTE = /^\/slots\/[^/]+\/spin/;
// How often an open tab re-reads which gates are coming: a gate can be published
// as little as 2 minutes before it ends, so this must beat that. The read is one
// cached same-origin GET (/api/lucky-draw-status), cheap as the pulls feed's 4 s.
const REFRESH_MS = 75_000;
const REFRESH_SPREAD_MS = 30_000;
const FOCUS_THROTTLE_MS = 30_000;
// setTimeout misbehaves far out, and a sleeping laptop overshoots anyway.
const MAX_SLEEP_MS = 60_000;
const NEXT_SHOW_GAP_MS = 900;

type GateIds = readonly { id: string; ends_at: string }[];

export type LiveDraw = {
  /** Watch these gates too: a page holding fresher gates than the status read. */
  track: (gates: GateIds) => void;
  /** Gates this tab knows are drawn: they leave the page's list. */
  drawn: ReadonlySet<string>;
  /** Draws still playing or waiting to play here: their result isn't told yet. */
  held: ReadonlySet<string>;
  /** Goes up as each show ends, so a results list can read again. */
  finished: number;
  /** Open a held draw full size. */
  watch: (id: string) => void;
};

const NOBODY: ReadonlySet<string> = new Set();

const Ctx = createContext<LiveDraw>({
  track: () => undefined,
  drawn: NOBODY,
  held: NOBODY,
  finished: 0,
  watch: () => undefined,
});

export const useLiveDraw = () => useContext(Ctx);

/**
 * The one owner of "a draw just landed", for the whole site: it watches every gate
 * still to draw, and when a result appears it pops the arena up in the corner, for
 * everyone signed in, entered or not (boss 2026-11-01: 全部; 不要看的人就按 X).
 * Signed-in only because a result needs a customer token, and that also keeps
 * visitors and bots out of the draw-minute reads.
 */
export function LiveDrawProvider({ children }: { children: ReactNode }) {
  const { customer } = useAuth();
  const customerId = customer?.id ?? null;
  const consent = useConsent();
  const pathname = usePathname();
  const [queue, setQueue] = useState<
    readonly { id: string; endsAt: number; detail: LuckyDrawResultDetail }[]
  >([]);
  const queueRef = useRef(queue);
  useEffect(() => {
    queueRef.current = queue;
  });
  // Gates closing in one minute play lowest class first, so a tab can't start any of
  // them until it has them all, or has waited as long as it will.
  const [batchWait, setBatchWait] = useState<{
    minute: number;
    until: number;
  } | null>(null);
  const playingRef = useRef<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [drawn, setDrawn] = useState<ReadonlySet<string>>(NOBODY);
  const [finished, setFinished] = useState(0);
  const [resting, setResting] = useState(false);
  const watchedRef = useRef<WatchedGate[]>([]);
  const doneRef = useRef(new Set<string>());
  const armRef = useRef<() => void>(() => undefined);

  const track = useCallback((gates: GateIds) => {
    watchedRef.current = mergeWatched(
      watchedRef.current,
      gates,
      doneRef.current,
      Date.now(),
      Math.random,
    );
    armRef.current();
  }, []);

  // A draw past `maxAge` isn't live any more, so it doesn't play as if it were:
  // Results has it. Age runs from the draw, so waiting never restarts the clock.
  const dropStale = useCallback((maxAge: number) => {
    const was = queueRef.current;
    const kept = freshShows(was, Date.now(), maxAge);
    if (kept === was) return;
    queueRef.current = kept;
    setQueue(kept);
    if (kept[0] !== was[0]) setExpanded(false);
    setFinished((n) => n + 1);
  }, []);

  useEffect(() => {
    if (!customerId) return;
    let live = true;
    let timer = 0;
    let refreshedAt = 0;

    const onResult = (gate: WatchedGate, found: LuckyDrawResultDetail) => {
      const { id, endsAt } = gate;
      doneRef.current.add(id);
      setDrawn((prev) => new Set(prev).add(id));
      const age = Date.now() - Date.parse(found.result.drawn_at);
      // No entries: nothing to play. Too old: it isn't live any more, Results has it.
      if (found.ticket_index == null || age > LIVE_MAX_AGE_MS) {
        setFinished((n) => n + 1);
        return;
      }
      if (readShownDraws().has(id)) return;
      recordShownDraw(id);
      const playing = playingRef.current;
      setQueue((q) => placeShow(q, { id, endsAt, detail: found }, playing));
    };

    // Called with `watchedRef` already past this result. A show of the minute already
    // playing means the wait is over: never pull it back off the screen.
    const settleBatch = (minute: number) => {
      const head = queueRef.current[0];
      const started =
        head?.id === playingRef.current &&
        head !== undefined &&
        drawMinute(head.endsAt) === minute;
      const until = started
        ? null
        : batchWaitUntil(watchedRef.current, minute, Date.now());
      setBatchWait((was) =>
        until !== null
          ? { minute, until }
          : was?.minute === minute
            ? null
            : was,
      );
    };

    const tick = async () => {
      // Hidden since this was armed: nobody is here to see it, and reading now would
      // use up the draw for another tab that is. Coming back re-arms.
      if (document.hidden) return;
      const now = Date.now();
      const due = dueGate(watchedRef.current, now);
      let foundMinute: number | null = null;
      if (due) {
        due.lookAt = nextLookAt(now, Math.random());
        // A Server Action can reject on its own (offline, a deploy): keep watching.
        const found = await getLuckyDrawEventResult(due.id, POOL_TITLE).catch(
          () => null,
        );
        if (!live) return;
        if (found) {
          onResult(due, found);
          foundMinute = drawMinute(due.endsAt);
        }
      }
      watchedRef.current = mergeWatched(
        watchedRef.current,
        [],
        doneRef.current,
        Date.now(),
        Math.random,
      );
      if (foundMinute !== null) settleBatch(foundMinute);
      arm();
    };

    const arm = () => {
      window.clearTimeout(timer);
      // A hidden tab reads nothing; coming back re-arms.
      if (!live || document.hidden) return;
      const at = nextWake(watchedRef.current);
      if (at === null) return;
      const wait = Math.min(MAX_SLEEP_MS, Math.max(50, at - Date.now()));
      timer = window.setTimeout(() => {
        void tick();
      }, wait);
    };
    armRef.current = arm;

    const refresh = async () => {
      refreshedAt = Date.now();
      const status = await readLuckyDrawStatus();
      if (live && status) track(status.upcoming);
    };
    void refresh();
    const every = window.setInterval(
      () => {
        if (!document.hidden) void refresh();
      },
      REFRESH_MS + Math.random() * REFRESH_SPREAD_MS,
    );
    const onBack = () => {
      if (document.hidden) return;
      dropStale(QUEUE_MAX_AGE_MS);
      if (Date.now() - refreshedAt >= FOCUS_THROTTLE_MS) void refresh();
      arm();
    };
    document.addEventListener('visibilitychange', onBack);
    window.addEventListener('focus', onBack);

    return () => {
      live = false;
      window.clearTimeout(timer);
      window.clearInterval(every);
      document.removeEventListener('visibilitychange', onBack);
      window.removeEventListener('focus', onBack);
      armRef.current = () => undefined;
      watchedRef.current = [];
      doneRef.current = new Set();
      playingRef.current = null;
      setQueue([]);
      setBatchWait(null);
      setExpanded(false);
      setDrawn(NOBODY);
    };
  }, [customerId, track, dropStale]);

  useEffect(() => {
    if (!batchWait) return;
    const id = window.setTimeout(
      () => setBatchWait(null),
      Math.max(0, batchWait.until - Date.now()),
    );
    return () => window.clearTimeout(id);
  }, [batchWait]);

  const closeShow = useCallback(() => {
    setQueue((q) => freshShows(q.slice(1), Date.now(), QUEUE_MAX_AGE_MS));
    setExpanded(false);
    setFinished((n) => n + 1);
    // A breath between two draws, so the second reads as its own moment.
    setResting(true);
  }, []);

  useEffect(() => {
    if (!resting) return;
    const id = window.setTimeout(() => setResting(false), NEXT_SHOW_GAP_MS);
    return () => window.clearTimeout(id);
  }, [resting]);

  const watch = useCallback((id: string) => {
    if (!queueRef.current.some((s) => s.id === id)) return;
    setQueue((q) => {
      const at = q.findIndex((s) => s.id === id);
      if (at <= 0) return q;
      const show = q[at];
      return show ? [show, ...q.filter((_, i) => i !== at)] : q;
    });
    // Asked for by name: it doesn't wait for the rest of its minute.
    setBatchWait(null);
    setExpanded(true);
  }, []);

  const held = useMemo(() => new Set(queue.map((s) => s.id)), [queue]);
  const value = useMemo(
    () => ({ track, drawn, held, finished, watch }),
    [track, drawn, held, finished, watch],
  );
  const show = queue[0];
  const onScreen =
    show &&
    !resting &&
    batchWait?.minute !== drawMinute(show.endsAt) &&
    consent !== null &&
    !SPIN_ROUTE.test(pathname);
  const playingId = onScreen ? show.id : null;
  useEffect(() => {
    if (playingId !== null) playingRef.current = playingId;
  }, [playingId]);

  // Held back by a pack rip or the cookie banner until it is too old to call live.
  // Draws waiting their turn behind another show are not held back: they play in
  // order, with the longer limit.
  const heldBackAt =
    show && !resting && !onScreen
      ? Date.parse(show.detail.result.drawn_at)
      : null;
  useEffect(() => {
    if (heldBackAt === null) return;
    const id = window.setTimeout(
      () => dropStale(LIVE_MAX_AGE_MS),
      Math.max(0, heldBackAt + LIVE_MAX_AGE_MS - Date.now()),
    );
    return () => window.clearTimeout(id);
  }, [heldBackAt, dropStale]);

  return (
    <Ctx.Provider value={value}>
      {children}
      {onScreen && (
        <ArenaBoundary key={show.id} onFail={closeShow}>
          <ArenaShow
            detail={show.detail}
            live
            expanded={expanded}
            lift={cornerLift(pathname)}
            onExpand={() => setExpanded(true)}
            onCollapse={() => setExpanded(false)}
            onClose={closeShow}
          />
        </ArenaBoundary>
      )}
    </Ctx.Provider>
  );
}

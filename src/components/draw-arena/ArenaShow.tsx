'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { ChevronDown, X } from 'lucide-react';
import { FramedAvatar } from '@/components/FramedAvatar';
import { Pill, pillVariants } from '@/components/ui/pill';
import { ArenaSim } from '@/lib/arena/engine';
import { arenaDots, arenaSeed, castDiscs } from '@/lib/arena/cast';
import {
  LAST_EAT_AT,
  phaseAt,
  REVEAL_MS,
  SHOW_MS,
  stepAt,
} from '@/lib/arena/timeline';
import { num, rmAuto } from '@/lib/format';
import {
  chancePercent,
  entriesIntact,
  TIER_LABEL,
  tilePrice,
  winnerIndex,
  type LuckyDrawTier,
} from '@/lib/lucky-draw';
import type { LuckyDrawResultDetail } from '@/lib/data/schemas';
import type { CornerLift } from '@/lib/lucky-draw-watch';
import { useModalA11y } from '@/lib/use-modal-a11y';
import { usePrefersReducedMotion } from '@/lib/use-reveal';
import { useSound } from '@/lib/use-sound';
import { cn } from '@/lib/utils';
import { PrizeArt } from '@/app/(account)/lucky-draw/PrizeCard';
import {
  FramedArt,
  type PoolPrize,
} from '@/app/(account)/lucky-draw/PoolParts';
import { createHoloDust } from '@/app/(account)/lucky-draw/holo-dust';
import {
  arenaHud,
  createArenaRenderer,
  type ArenaCast,
  type ArenaEvent,
  type ArenaHud,
} from './arena-render';
import { loadTokenSprites } from './token-sprites';

/** How long the table holds still for its pictures, so the show opens on faces. A
 *  slow picture swaps in when it arrives; it never holds the draw longer than this. */
const PICTURE_WAIT_MS = 1500;
const HUD_EVERY_MS = 140;
/** Past this the battle has stopped being a moment the phone should be working on. */
const COMPUTE_GIVE_UP_MS = 6000;
const SLICE_MS = 6;
const TICK_GAP_MS = 70;
/** How long a finished popup stays before it clears itself. A win stays. */
const MINI_LINGER_MS = 9000;
const NOTABLE_EAT = 0.012;

const LIFT: Record<CornerLift, string> = {
  tabs: 'bottom-[calc(4.5rem+env(safe-area-inset-bottom))]',
  // A landscape phone has no room for the higher lifts: the X must stay on screen.
  bar: 'bottom-[calc(12rem+env(safe-area-inset-bottom))] short:bottom-[calc(4.5rem+env(safe-area-inset-bottom))]',
  tray: 'bottom-[calc(15rem+env(safe-area-inset-bottom))] short:bottom-[calc(4.5rem+env(safe-area-inset-bottom))]',
};

const short = (name: string, max = 16) =>
  name.length > max ? `${name.slice(0, max - 1)}…` : name;

function calloutFor(t: number, cast: ArenaCast, alive: number): string | null {
  switch (phaseAt(t, cast.run)) {
    case 'boosters':
      return 'Boosters in';
    case 'frenzy':
      return 'Feeding frenzy';
    case 'closing':
      return 'The table closes';
    case 'final':
      return alive <= 2 ? 'Last two' : `Final ${alive}`;
    default:
      return null;
  }
}

/**
 * The draw, as a show: a battle of discs that ends on the stored winner. Live, it
 * is a small card in the corner that a tap opens up and an X closes, with no way to
 * skip (boss 2026-11-01). From Results it opens full size and can skip to the
 * result. Same battle both times, from the same seed.
 */
export function ArenaShow({
  detail,
  live,
  expanded,
  lift = 'tabs',
  onExpand,
  onCollapse,
  onClose,
}: {
  detail: LuckyDrawResultDetail;
  /** The live moment: no skip. False is the replay from Results. */
  live: boolean;
  expanded: boolean;
  /** How high the corner card sits on a phone, to clear this page's action. */
  lift?: CornerLift;
  onExpand: () => void;
  onCollapse: () => void;
  /** The X, Done, or a finished popup clearing itself. */
  onClose: () => void;
}) {
  const { result, entries, prizes } = detail;
  const people = useMemo(() => entries.map((e) => e.person), [entries]);
  const myIndex = detail.my_entry_index ?? null;
  const intact = entriesIntact(entries, result);
  const win = intact ? winnerIndex(entries, detail.ticket_index) : -1;
  const iWon = win >= 0 && win === myIndex;
  const tier = (result.tier ?? null) as LuckyDrawTier | null;
  const reduced = usePrefersReducedMotion();
  const fan = prizes?.slice(1, 3) ?? [];
  // The prize that fronts the pool: an old per-prize result has only its own.
  const face: PoolPrize = prizes?.[0] ?? {
    title: result.title,
    image: result.image,
    frame: result.frame,
    value_myr: result.value_myr,
  };

  const rootRef = useRef<HTMLDivElement>(null);
  const expandRef = useRef<HTMLButtonElement>(null);
  const wasExpanded = useRef(expanded);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dustRef = useRef<HTMLCanvasElement>(null);
  const skipRef = useRef(false);
  const expandedRef = useRef(expanded);
  const onCloseRef = useRef(onClose);
  const { sfx, duck } = useSound();
  const sfxRef = useRef(sfx);

  const [cast, setCast] = useState<ArenaCast | null>(null);
  const [broken, setBroken] = useState(false);
  const [hud, setHud] = useState<ArenaHud | null>(null);
  const [callout, setCallout] = useState<string | null>(null);
  const [feed, setFeed] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [ended, setEnded] = useState(false);
  const [take, setTake] = useState(0);

  useEffect(() => {
    expandedRef.current = expanded;
    sfxRef.current = sfx;
    onCloseRef.current = onClose;
  });

  // The music bed steps back while the show has the whole screen.
  useEffect(() => {
    if (!expanded) return;
    duck(true);
    return () => duck(false);
  }, [expanded, duck]);

  // Escape folds a live show back to the corner, and closes a replay.
  const escape = live ? onCollapse : onClose;
  useModalA11y(rootRef, expanded, escape);

  // Folding back: the button that opened it left the page while it was open, so
  // focus has to be handed to the new one or it falls to the body.
  useEffect(() => {
    if (wasExpanded.current && !expanded) {
      expandRef.current?.focus({ preventScroll: true });
    }
    wasExpanded.current = expanded;
  }, [expanded]);

  // No battle to play: a list that doesn't add up. The result is told as it
  // stands, straight away. Reduced motion still plays it: the battle is the draw
  // itself, and a customer with Reduce Motion on asked to watch it (2026-11-04).
  // Only the decoration around it (dust, zooms, entrances) stays still.
  const skipShow = win < 0 || broken;
  const told = skipShow || revealed;
  const over = skipShow || ended;

  // Run the battle in slices, so a slow phone keeps scrolling while it works. The
  // seed is the draw's own, so every device and every replay plays the same run.
  useEffect(() => {
    if (win < 0) return;
    const seed = arenaSeed(`${result.seed}:${result.prize_id}`);
    const dots = arenaDots(entries.length);
    const sim = new ArenaSim(seed, dots);
    let raf = 0;
    // Only time the phone was on it counts: a hidden tab pauses the frames, and a
    // tab coming back must not find its draw given up on.
    let spent = 0;
    let lastSlice = 0;
    const slice = (now: number) => {
      if (lastSlice > 0 && now - lastSlice < 1000) spent += now - lastSlice;
      lastSlice = now;
      if (spent > COMPUTE_GIVE_UP_MS) {
        setBroken(true);
        return;
      }
      const until = performance.now() + SLICE_MS;
      try {
        while (!sim.done && performance.now() < until) sim.advance();
        if (!sim.done) {
          raf = requestAnimationFrame(slice);
          return;
        }
        const run = sim.result();
        const owners = castDiscs({
          tickets: entries.map((e) => e.tickets),
          winner: win,
          me: myIndex,
          survivor: run.survivor,
          dots,
          seed,
        });
        // The stored result is the truth: a disc that ended anywhere else, or more
        // than one left standing, means the arena is wrong, so it is not shown.
        if (run.eats.length !== dots - 1 || owners[run.survivor] !== win) {
          setBroken(true);
          return;
        }
        setCast({
          run,
          owners,
          names: entries.map((e) => e.person.who),
          me: myIndex,
        });
      } catch {
        setBroken(true);
      }
    };
    raf = requestAnimationFrame(slice);
    return () => cancelAnimationFrame(raf);
  }, [entries, myIndex, result.prize_id, result.seed, win]);

  // The show itself: one clock, one canvas, from the first frame. A hidden tab
  // pauses the frames, so it picks up where it was instead of jumping to the end.
  useEffect(() => {
    const canvas = canvasRef.current;
    const stage = stageRef.current;
    if (!cast || !canvas || !stage) return;
    const sprites = loadTokenSprites(people);
    let lastTick = 0;
    const onEvent = (e: ArenaEvent) => {
      if (!expandedRef.current) return;
      const now = performance.now();
      if (e.kind === 'last') {
        sfxRef.current('drawStop');
      } else if (now - lastTick >= TICK_GAP_MS) {
        lastTick = now;
        sfxRef.current('drawTick');
      }
    };
    const renderer = createArenaRenderer(canvas, cast, sprites, onEvent);
    let t = 0;
    const fit = () => {
      const box = stage.getBoundingClientRect();
      renderer.resize(box.width, box.height);
      // A resize clears the canvas, and once the show has ended no frame redraws it.
      if (t > 0) renderer.draw(t, 0);
    };
    fit();
    const watcher = new ResizeObserver(fit);
    watcher.observe(stage);

    const noteEats = cast.run.eats.filter(
      (e) =>
        cast.owners[e.eater] !== cast.owners[e.eaten] &&
        e.mass /
          (cast.run.masses[
            cast.run.frameStart[cast.run.radius.length - 1] as number
          ] as number) >=
          NOTABLE_EAT,
    );
    const nameOf = (entry: number | undefined, you: string) =>
      entry === cast.me ? you : short(cast.names[entry ?? -1] ?? '', 14);

    let last = performance.now();
    let raf = 0;
    let lastHud = -Infinity;
    let told2 = false;
    let finished = false;
    let started = false;
    let feedAt = 0;
    let lastCallout: string | null = null;
    const frame = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      if (!started) {
        started = true;
        if (expandedRef.current) sfxRef.current('drawStart');
      }
      if (skipRef.current) {
        skipRef.current = false;
        t = Math.max(t, REVEAL_MS);
        renderer.draw(t, 0);
      } else {
        t += dt * 1000;
        renderer.draw(t, dt);
      }
      if (t - lastHud >= HUD_EVERY_MS) {
        lastHud = t;
        const step = stepAt(t, cast.run.lastStep);
        const next = arenaHud(cast, step);
        setHud(next);
        setProgress(Math.min(1, t / SHOW_MS));
        const say = t < LAST_EAT_AT ? calloutFor(t, cast, next.alive) : null;
        if (say !== lastCallout) {
          lastCallout = say;
          setCallout(say);
        }
        while (
          feedAt < noteEats.length &&
          (noteEats[feedAt]?.step ?? Infinity) <= step
        ) {
          const e = noteEats[feedAt++];
          if (!e) continue;
          const eater = cast.owners[e.eater];
          const eaten = cast.owners[e.eaten];
          setFeed(
            eaten === cast.me
              ? `${nameOf(eater, 'You')} swallowed you`
              : `${nameOf(eater, 'You')} swallowed ${nameOf(eaten, 'you')}`,
          );
        }
      }
      if (!told2 && t >= REVEAL_MS) {
        told2 = true;
        setRevealed(true);
        if (expandedRef.current) sfxRef.current('drawWin');
      }
      if (!finished && t >= SHOW_MS) {
        finished = true;
        setEnded(true);
      }
      // A little past the end, so the last rings settle, then the phone rests.
      if (t < SHOW_MS + 1500) raf = requestAnimationFrame(frame);
    };
    // The table, still, until its pictures are in.
    renderer.draw(0, 0);
    let gone = false;
    let hold = 0;
    const paint = () => {
      if (gone) return;
      renderer.draw(0, 0);
      hold = window.setTimeout(paint, 120);
    };
    hold = window.setTimeout(paint, 120);
    void Promise.race([
      sprites.ready,
      new Promise((r) => window.setTimeout(r, PICTURE_WAIT_MS)),
    ]).then(() => {
      window.clearTimeout(hold);
      if (gone) return;
      last = performance.now();
      raf = requestAnimationFrame(frame);
    });
    return () => {
      gone = true;
      window.clearTimeout(hold);
      cancelAnimationFrame(raf);
      watcher.disconnect();
      sprites.stop();
    };
  }, [cast, people, take]);

  // The dust, once, as the winner is told.
  useEffect(() => {
    const canvas = dustRef.current;
    if (!canvas || !revealed || reduced) return;
    const dust = createHoloDust(canvas);
    dust.burst();
    const wave = window.setTimeout(() => dust.wave(), 500);
    return () => {
      window.clearTimeout(wave);
      dust.stop();
    };
  }, [revealed, reduced]);

  // The corner card clears itself once it has said who won; a win waits.
  useEffect(() => {
    if (!live || expanded || !over || iWon) return;
    let id = 0;
    const clear = () => {
      // Not while nobody can see it, or the next draw starts unseen.
      if (document.hidden) id = window.setTimeout(clear, 1000);
      else onCloseRef.current();
    };
    id = window.setTimeout(clear, MINI_LINGER_MS);
    return () => window.clearTimeout(id);
  }, [live, expanded, over, iWon]);

  const again = () => {
    setRevealed(false);
    setEnded(false);
    setProgress(0);
    setFeed(null);
    setTake((n) => n + 1);
  };

  const winner = result.winner;
  const hero = prizes?.[0];
  const tierLabel = tier ? TIER_LABEL[tier] : null;
  const leaders = hud?.leaders ?? [];
  const myEntryIn = myIndex != null && myIndex >= 0;

  const youLine = (() => {
    if (!myEntryIn) return 'You’re watching. Enter the next gate to get discs.';
    const mine = hud?.mine;
    if (!mine)
      return `Your ${num(entries[myIndex]?.tickets ?? 0)} tickets are in`;
    if (mine.alive === 0) return 'All your discs are gone. Watch who takes it.';
    if (leaders[0]?.entry === myIndex)
      return `You lead with ${Math.round(mine.share * 100)}%`;
    if (hud && hud.alive <= 10) return 'You’re in the final';
    return `${num(mine.alive)} of your ${num(mine.total)} discs alive`;
  })();

  return (
    <div
      ref={rootRef}
      role={expanded ? 'dialog' : 'complementary'}
      aria-modal={expanded ? true : undefined}
      aria-label={live ? 'Lucky Draw, live' : 'Lucky Draw replay'}
      tabIndex={expanded ? -1 : undefined}
      className={cn(
        'outline-none',
        expanded
          ? 'fixed inset-0 z-[60] flex flex-col overflow-x-hidden overflow-y-auto bg-neutral-950 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]'
          : cn(
              'arena-mini-in fixed right-[max(0.75rem,env(safe-area-inset-right))] z-40 w-[clamp(9.5rem,44vw,11rem)] overflow-hidden rounded-2xl border border-white/15 bg-neutral-950 shadow-[0_25px_60px_-15px_rgb(0_0_0/.85)] lg:right-6 lg:bottom-6 lg:w-72',
              LIFT[lift],
            ),
      )}
    >
      {/* Always mounted, so the result is announced in the corner and full size. */}
      <p role="status" className="sr-only">
        {told
          ? winner
            ? `${iWon ? 'You' : winner.who} won ${rmAuto(result.value_myr)}`
            : 'No entries, so nothing was drawn.'
          : ''}
      </p>
      {expanded && (
        <header className="flex shrink-0 items-center gap-3 px-4 py-2.5">
          <span className="relative aspect-[5/7] w-9 shrink-0 overflow-hidden rounded-md border border-white/10 bg-white/[0.04] p-0.5">
            <span className="relative block h-full w-full">
              <PrizeArt
                src={result.image}
                kind={hero?.kind}
                frame={result.frame}
                eager
              />
            </span>
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-white">
              {tierLabel ? `${tierLabel} · ` : ''}
              {result.title}
            </p>
            <p className="font-heading text-lg leading-tight text-chase tabular-nums">
              {rmAuto(result.value_myr)}
            </p>
          </div>
          {live ? (
            <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-neutral-800 px-2.5 py-1 text-[11px] font-semibold text-white">
              <span
                className="h-1.5 w-1.5 animate-pulse rounded-full bg-white motion-reduce:animate-none"
                aria-hidden
              />
              LIVE
            </span>
          ) : (
            <span className="shrink-0 rounded-full bg-neutral-800 px-2.5 py-1 text-[11px] font-semibold text-neutral-300">
              Replay
            </span>
          )}
          {live && (
            <button
              type="button"
              onClick={onCollapse}
              aria-label="Shrink the draw to the corner"
              className="-mr-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-white/60 transition-colors outline-none hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-white/40"
            >
              <ChevronDown className="h-5 w-5" aria-hidden />
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close the draw"
            className="-mr-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-white/60 transition-colors outline-none hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-white/40"
          >
            <X className="h-5 w-5" aria-hidden />
          </button>
        </header>
      )}

      <div
        className={cn(
          expanded &&
            'flex flex-1 flex-col items-center justify-start gap-3 short:grid short:grid-cols-[auto_minmax(0,1fr)] short:items-start lg:grid lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] lg:items-center lg:gap-8 lg:px-8',
        )}
      >
        {/* Beside the table on a wide screen: what the battle is for. */}
        {expanded && (
          <aside
            className={cn(
              'hidden min-w-0 lg:block lg:justify-self-end',
              told && 'lg:invisible',
            )}
          >
            <div className="relative aspect-[5/7] w-[clamp(9rem,14vw,14rem)]">
              <FramedArt prize={face} holo eager />
            </div>
          </aside>
        )}

        <div
          className={cn(
            'relative aspect-square shrink-0',
            expanded
              ? 'w-[min(100vw,calc(100dvh-18rem))] short:w-[calc(100dvh-5rem)] lg:w-[min(46vw,calc(100dvh-7rem))]'
              : 'w-full',
          )}
        >
          <div
            ref={stageRef}
            className={cn(
              'absolute inset-0 transition-[scale,filter] duration-900 ease-[cubic-bezier(.2,.8,.2,1)] motion-reduce:transition-none',
              told &&
                expanded &&
                'scale-86 brightness-38 saturate-80 [mask-image:radial-gradient(closest-side,#000_72%,transparent)]',
            )}
          >
            {!skipShow && (
              <canvas
                ref={canvasRef}
                aria-hidden
                className="absolute inset-0 h-full w-full"
              />
            )}
            {/* No battle to play: the corner still shows what was drawn. */}
            {skipShow && !expanded && (
              <div className="absolute inset-0 grid place-items-center">
                <div className="relative aspect-[5/7] h-[84%]">
                  <FramedArt prize={face} eager />
                </div>
              </div>
            )}
          </div>

          {expanded && callout && !told && (
            <p
              key={callout}
              aria-hidden
              className="arena-callout font-heading pointer-events-none absolute inset-x-0 top-[7%] text-center text-[clamp(1.1rem,6vw,2rem)] tracking-wide text-white uppercase [text-shadow:0_2px_16px_rgb(0_0_0/.9)]"
            >
              {callout}
            </p>
          )}

          {!cast && !skipShow && (
            <p className="pointer-events-none absolute inset-0 grid place-items-center text-xs font-semibold text-neutral-400">
              Opening the arena…
            </p>
          )}

          {expanded && !reduced && (
            <canvas
              ref={dustRef}
              aria-hidden
              className="pointer-events-none absolute -top-[20%] -left-[10%] h-full w-[120%]"
            />
          )}

          {/* The prize rises over the table in its foil frame, as it always has. */}
          {expanded && (
            <div
              aria-hidden
              className={cn(
                'pointer-events-none absolute inset-0 grid place-items-center transition-[opacity,translate,scale] delay-150 duration-700 ease-[cubic-bezier(.2,.8,.2,1)] motion-reduce:transition-none',
                told ? 'opacity-100' : 'translate-y-[18px] scale-94 opacity-0',
              )}
            >
              <div className="relative aspect-[5/7] w-[38%]">
                {fan.map((p, i) => (
                  <div
                    key={i}
                    className={cn(
                      'absolute inset-0 scale-90',
                      i === 0
                        ? '-translate-x-[38%] -rotate-[9deg]'
                        : 'translate-x-[38%] rotate-[9deg]',
                    )}
                  >
                    <FramedArt prize={p} />
                  </div>
                ))}
                <div className="absolute inset-0">
                  <FramedArt prize={face} holo />
                </div>
              </div>
            </div>
          )}

          {/* The time left, so the show never feels open-ended. */}
          {!told && !skipShow && (
            <div
              aria-hidden
              className="absolute inset-x-0 bottom-0 h-0.5 bg-white/10"
            >
              <div
                className="h-full bg-white/70"
                style={{ width: `${progress * 100}%` }}
              />
            </div>
          )}

          {!expanded && (
            <>
              <span className="pointer-events-none absolute top-1.5 left-1.5 flex items-center gap-1 rounded-full bg-neutral-950/80 px-2 py-0.5 text-[10px] font-semibold text-white">
                <span
                  className="h-1.5 w-1.5 animate-pulse rounded-full bg-white motion-reduce:animate-none"
                  aria-hidden
                />
                LIVE
              </span>
              <button
                ref={expandRef}
                type="button"
                onClick={onExpand}
                aria-label="Watch the Lucky Draw"
                className="absolute inset-0 rounded-t-2xl outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/60"
              />
              {/* 28 to see, 44 to hit: the corner is a small target to get right. */}
              <button
                type="button"
                onClick={onClose}
                aria-label="Close the draw"
                className="absolute top-1 right-1 flex h-7 w-7 items-center justify-center rounded-full bg-neutral-950/80 text-white/80 outline-none before:absolute before:-inset-2 before:content-[''] hover:text-white focus-visible:ring-2 focus-visible:ring-white/60"
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
            </>
          )}
        </div>

        {expanded && (
          <section className="w-full min-w-0 px-4 pb-4 short:pr-4 short:pl-0 lg:max-w-sm lg:justify-self-start lg:px-0">
            {!told ? (
              <>
                <p
                  className={cn(
                    'rounded-xl border border-white/10 bg-neutral-900 px-3 py-2 text-sm font-semibold tabular-nums',
                    myEntryIn ? 'text-white' : 'text-neutral-300',
                  )}
                >
                  {youLine}
                </p>
                <p className="mt-2 flex items-baseline justify-between gap-3 text-[11px] font-semibold text-neutral-400 tabular-nums">
                  <span>
                    {num(result.total_tickets)} tickets ·{' '}
                    {num(result.entrant_count)}{' '}
                    {result.entrant_count === 1 ? 'player' : 'players'}
                  </span>
                  {hud && <span>{num(hud.alive)} discs left</span>}
                </p>
                <ul className="mt-2 space-y-1.5" aria-hidden>
                  {leaders.map((l) => {
                    const person = people[l.entry];
                    if (!person) return null;
                    return (
                      <li
                        key={l.entry}
                        className="flex items-center gap-2 text-xs"
                      >
                        <FramedAvatar
                          src={person.avatar}
                          initial={person.who.charAt(0).toUpperCase() || '?'}
                          size={22}
                        />
                        <span
                          className={cn(
                            'w-[7.5rem] shrink-0 truncate font-semibold',
                            l.entry === myIndex
                              ? 'text-white'
                              : 'text-neutral-300',
                          )}
                        >
                          {l.entry === myIndex ? 'You' : person.who}
                        </span>
                        <span className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-white/10">
                          <span
                            className="block h-full rounded-full bg-neutral-200 transition-[width] duration-200"
                            style={{ width: `${l.share * 100}%` }}
                          />
                        </span>
                        <span className="w-9 shrink-0 text-right font-semibold text-neutral-300 tabular-nums">
                          {Math.round(l.share * 100)}%
                        </span>
                      </li>
                    );
                  })}
                </ul>
                <p
                  aria-hidden
                  className="mt-2 min-h-4 truncate text-xs text-neutral-400 squat:hidden"
                >
                  {feed}
                </p>
                {/* The stakes stay in sight where there is room: the cards are
                    why anyone is watching. A wide screen has them beside the table. */}
                {prizes && prizes.length > 0 && (
                  <div className="mt-3 hidden [@media(min-height:44rem)]:block lg:hidden!">
                    <p className="text-[11px] font-semibold tracking-wide text-neutral-400 uppercase">
                      Playing for
                    </p>
                    <ul className="mt-1.5 flex gap-2">
                      {prizes.slice(0, 3).map((p, i) => (
                        <li
                          key={i}
                          className="flex min-w-0 flex-1 items-center gap-2 rounded-xl border border-white/10 bg-neutral-900 p-1.5"
                        >
                          <span className="relative aspect-[5/7] w-9 shrink-0 overflow-hidden rounded-md bg-white/[0.04] p-0.5">
                            <span className="relative block h-full w-full">
                              <PrizeArt
                                src={p.image}
                                kind={p.kind}
                                frame={p.frame}
                              />
                            </span>
                          </span>
                          <span className="min-w-0">
                            <span className="block truncate text-[11px] leading-tight text-neutral-200">
                              {p.title}
                            </span>
                            <span className="font-heading mt-0.5 block text-xs whitespace-nowrap text-chase tabular-nums">
                              {rmAuto(tilePrice(p.value_myr))}
                            </span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {!live && !skipShow && (
                  <div className="mt-2 flex justify-center">
                    <Pill
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        skipRef.current = true;
                      }}
                    >
                      Skip to result
                    </Pill>
                  </div>
                )}
              </>
            ) : (
              <div className="arena-told text-center lg:text-left">
                {winner ? (
                  <>
                    <p
                      className={cn(
                        'text-[11px] font-semibold tracking-[0.16em] uppercase',
                        iWon ? 'text-chase' : 'text-neutral-400',
                      )}
                    >
                      {iWon ? 'You won' : 'Winner'}
                    </p>
                    <p className="mt-1 flex items-center justify-center gap-2 lg:justify-start">
                      <FramedAvatar
                        src={winner.avatar}
                        frameSrc={winner.frame}
                        initial={winner.who.charAt(0).toUpperCase() || '?'}
                        size={32}
                      />
                      <span className="font-heading min-w-0 truncate text-2xl leading-tight text-white">
                        {iWon ? 'Yours!' : winner.who}
                      </span>
                    </p>
                    <p className="mt-1 text-sm text-neutral-400 tabular-nums">
                      {num(result.winner_tickets)} of{' '}
                      {num(result.total_tickets)} tickets ·{' '}
                      {chancePercent(
                        result.winner_tickets,
                        result.total_tickets,
                      )}{' '}
                      chance
                    </p>
                  </>
                ) : (
                  <p className="text-sm text-neutral-300">
                    No entries, so nothing was drawn.
                  </p>
                )}
                {!intact && (
                  <p className="mt-1 text-xs text-neutral-400">
                    Entry list couldn&rsquo;t be read — refresh.
                  </p>
                )}
                {prizes && prizes.length > 0 && (
                  <div className="mx-auto mt-3 max-w-xs text-left lg:mx-0">
                    <p className="flex items-baseline justify-between gap-3 text-[11px] font-semibold tracking-wide text-neutral-400 uppercase">
                      <span>Takes every prize</span>
                      <span className="font-heading text-base tracking-normal text-chase tabular-nums normal-case">
                        {rmAuto(result.value_myr)}
                      </span>
                    </p>
                    <ul className="mt-1 space-y-0.5 squat:hidden">
                      {prizes.slice(0, 3).map((p, i) => (
                        <li
                          key={i}
                          className="flex items-baseline justify-between gap-3 text-sm text-neutral-200"
                        >
                          <span className="min-w-0 truncate">{p.title}</span>
                          <span className="shrink-0 text-xs text-neutral-400 tabular-nums">
                            {rmAuto(p.value_myr)}
                          </span>
                        </li>
                      ))}
                    </ul>
                    {prizes.length > 3 && (
                      <p className="mt-0.5 text-xs text-neutral-400 squat:hidden">
                        and {num(prizes.length - 3)} more
                      </p>
                    )}
                  </div>
                )}
                <div className="mt-4 flex flex-wrap items-center justify-center gap-2 lg:justify-start">
                  {live ? (
                    <Link
                      href={iWon ? '/vault' : '/lucky-draw'}
                      onClick={onClose}
                      className={pillVariants({
                        variant: 'primary',
                        size: 'md',
                      })}
                    >
                      {iWon ? 'See it in your vault' : 'Enter the next gate'}
                    </Link>
                  ) : (
                    !skipShow && (
                      <Pill variant="secondary" size="md" onClick={again}>
                        Watch again
                      </Pill>
                    )
                  )}
                  <Pill
                    variant={live ? 'secondary' : 'primary'}
                    size="md"
                    onClick={onClose}
                  >
                    Done
                  </Pill>
                </div>
              </div>
            )}
          </section>
        )}
      </div>

      {!expanded && (
        <div className="flex min-h-11 items-center gap-1.5 border-t border-white/10 px-2 py-1.5">
          {told && winner ? (
            <>
              <FramedAvatar
                src={winner.avatar}
                initial={winner.who.charAt(0).toUpperCase() || '?'}
                size={22}
              />
              <span className="min-w-0 flex-1">
                <span
                  className={cn(
                    'block text-[10px] leading-tight font-semibold',
                    iWon ? 'text-chase' : 'text-neutral-400',
                  )}
                >
                  {iWon ? 'You won!' : 'Winner'}
                </span>
                <span className="block truncate text-xs leading-tight font-semibold text-white">
                  {winner.who}
                </span>
              </span>
            </>
          ) : (
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[11px] leading-tight font-semibold text-white">
                {tierLabel ? `${tierLabel} · ` : ''}
                {result.title}
              </span>
              <span className="block truncate text-[10px] leading-tight text-neutral-400 tabular-nums">
                {hud && hud.mine && hud.mine.alive > 0
                  ? `${num(hud.mine.alive)} of yours left`
                  : hud
                    ? `${num(hud.alive)} discs left`
                    : `${num(result.total_tickets)} tickets`}
              </span>
            </span>
          )}
        </div>
      )}
    </div>
  );
}

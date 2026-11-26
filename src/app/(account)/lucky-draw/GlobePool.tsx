'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ChevronRight, X } from 'lucide-react';
import {
  createGlobeScene,
  type GlobeAnchor,
  type GlobeScene,
} from '@/components/draw-globe/globe-scene';
import { cn } from '@/lib/utils';
import { num, rmAuto } from '@/lib/format';
import { useMediaQuery, usePrefersReducedMotion } from '@/lib/use-reveal';
import {
  assignRoutes,
  flightProgress,
  GLOBE_STAGE,
  planeKind,
  shortTimeLeft,
} from '@/lib/draw-globe';
import {
  chancePercent,
  countdownClock,
  drawCountdown,
  heroFirst,
  POOL_TITLE,
  potTotal,
  sortGates,
  TIER_LABEL,
  type LuckyDrawTier,
} from '@/lib/lucky-draw';
import type { LuckyDrawGate } from '@/lib/data/schemas';
import {
  GateAction,
  GateList,
  GatePrizes,
  Stat,
  useGateSheets,
} from './GateList';
import { HowItWorks } from './HowItWorks';
import { FramedArt } from './PoolParts';

// The open pin's stem, and how long it takes to shrink back.
const STEM = 60;
const LEAVE_MS = 180;
const EDGE = 6;
/** Tailwind's `short`: too low for the pin to grow upwards, so it grows to
 *  the plane's side. */
const SIDEWAYS = '(max-height: 31.25rem)';
/** How far right of the plane the sideways pin starts, in px (left-15). */
const SIDE_GAP = 60;
/** The floating dock's height and gap over the foot of the screen. */
const DOCK = 70;
/** How much of the stage, from its top, the dock leaves in view. */
const sideRoom = (stage: HTMLElement | null, height: number) =>
  stage
    ? Math.max(
        120,
        Math.min(
          height,
          window.innerHeight - DOCK - stage.getBoundingClientRect().top,
        ),
      )
    : height;

const tierName = (gate: LuckyDrawGate) =>
  gate.tier ? TIER_LABEL[gate.tier as LuckyDrawTier] : null;

/** A plane's pin: its class, the time left, the pot and the top prize. */
function Pin({
  gate,
  nowMs,
  isNew,
  open,
  onOpen,
}: {
  gate: LuckyDrawGate;
  nowMs: number | null;
  isNew: boolean;
  open: boolean;
  onOpen: () => void;
}) {
  const prizes = heroFirst(gate.prizes);
  const hero = prizes[0];
  const clock = nowMs == null ? null : countdownClock(gate.ends_at, nowMs);
  const closed = nowMs != null && !clock;
  const tier = tierName(gate);
  const pot = rmAuto(potTotal(prizes));
  return (
    <button
      type="button"
      data-pin
      onClick={onOpen}
      aria-expanded={open}
      aria-label={`${tier ?? POOL_TITLE} prize pool, ${pot}. ${
        closed
          ? 'Gate closed'
          : nowMs == null
            ? ''
            : `Gate closes in ${drawCountdown(gate.ends_at, nowMs)}`
      }. See details`}
      className={cn(
        'absolute bottom-full left-1/2 mb-7 flex origin-bottom translate-x-[calc(-50%+var(--pin-shift,0px))] items-center gap-2 rounded-2xl border border-white/15 bg-neutral-900/95 py-1.5 pr-3 pl-1.5 text-left shadow-[0_8px_24px_rgba(0,0,0,0.45)] transition-[scale,opacity,border-color] duration-200 outline-none hover:border-white/40 focus-visible:ring-2 focus-visible:ring-white/70 active:scale-[0.97]',
        open &&
          'pointer-events-none scale-50 opacity-0 motion-reduce:scale-100',
      )}
    >
      {hero && (
        <span className="relative block aspect-[5/7] w-7 shrink-0">
          <FramedArt prize={hero} eager />
        </span>
      )}
      <span className="min-w-0">
        <span className="flex items-center gap-1.5 text-[9.5px] leading-tight font-semibold tracking-[0.08em] whitespace-nowrap text-neutral-400 uppercase">
          {tier ?? POOL_TITLE}
          <span aria-hidden>·</span>
          <span className="tabular-nums">
            {closed ? 'Gate closed' : clock ? shortTimeLeft(clock) : '--'}
          </span>
          {isNew && (
            <span className="rounded-full bg-neutral-50 px-1 py-px text-[8px] leading-none text-neutral-950">
              NEW
            </span>
          )}
        </span>
        <span
          className={cn(
            'font-heading block text-[15px] leading-tight whitespace-nowrap tabular-nums',
            closed ? 'text-neutral-300' : 'text-chase',
          )}
        >
          {pot}
        </span>
      </span>
    </button>
  );
}

/** The pin, grown: the prize, where the player stands and the one action. */
function Detail({
  gate,
  nowMs,
  isNew,
  leaving,
  balance,
  spinHref,
  cardRef,
  onClose,
  onEnter,
  sheets,
}: {
  gate: LuckyDrawGate;
  nowMs: number | null;
  isNew: boolean;
  leaving: boolean;
  balance: number;
  spinHref: string | null;
  cardRef: React.RefObject<HTMLDialogElement | null>;
  onClose: () => void;
  onEnter: () => void;
  sheets: ReturnType<typeof useGateSheets>;
}) {
  const prizes = heroFirst(gate.prizes);
  const hero = prizes[0];
  const closed = nowMs != null && !countdownClock(gate.ends_at, nowMs);
  const tier = tierName(gate);
  const titleId = `pin-${gate.id}`;
  // Non-modal: the globe stays live around it. Opened before first paint so
  // its grow-in starts from @starting-style.
  useLayoutEffect(() => {
    const d = cardRef.current;
    if (d && !d.open) d.show();
  }, [cardRef]);
  const header = (
    <div className="min-w-0 flex-1">
      <div className="flex items-start gap-2">
        <h2
          id={titleId}
          className="min-w-0 flex-1 pt-1 text-[11px] leading-tight font-semibold tracking-[0.08em] text-neutral-400 uppercase short:truncate"
        >
          {POOL_TITLE}
          {tier && ` · ${tier}`}
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="-mt-2 -mr-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-neutral-400 transition-colors outline-none hover:text-white focus-visible:ring-2 focus-visible:ring-white/60"
        >
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-neutral-800">
            <X className="h-4 w-4" aria-hidden />
          </span>
        </button>
      </div>
      <p className="font-heading -mt-1.5 truncate text-[clamp(1.4rem,7vw,1.75rem)] leading-none short:text-[1.35rem] text-chase tabular-nums">
        {rmAuto(potTotal(prizes))}
      </p>
      {hero && prizes.length === 1 && (
        <p className="mt-2 truncate text-sm font-medium text-white">
          {hero.title}
        </p>
      )}
      <p
        className={cn(
          'truncate text-xs text-neutral-400 short:hidden',
          prizes.length !== 1 && 'mt-2',
        )}
      >
        {prizes.length === 1
          ? 'One winner takes it'
          : `One winner takes all ${num(prizes.length)}`}
      </p>
      <p className="mt-2 flex items-center gap-1.5">
        {closed ? (
          <span className="rounded-full bg-neutral-800 px-2 py-0.5 text-[11px] font-semibold text-neutral-300">
            Gate closed
          </span>
        ) : (
          <span className="flex items-center gap-1.5 rounded-full bg-coral px-2 py-0.5 text-[11px] font-semibold text-neutral-950">
            <span
              aria-hidden
              className="h-1.5 w-1.5 rounded-full bg-neutral-950"
            />
            Live
          </span>
        )}
        {isNew && (
          <span className="rounded-full bg-neutral-50 px-1.5 py-0.5 text-[9px] leading-none font-semibold text-neutral-950">
            NEW
          </span>
        )}
      </p>
    </div>
  );
  return (
    <dialog
      ref={cardRef}
      aria-labelledby={titleId}
      tabIndex={-1}
      className={cn(
        // It grows out of the pin's own point, the end of its stem; on a low
        // screen, out of the plane's side, in two columns. Under reduced
        // motion it only fades.
        'absolute right-auto bottom-full left-1/2 m-0 mb-[3.75rem] max-h-[var(--card-max,none)] w-[min(22rem,calc(100vw-1.5rem))] origin-[calc(50%-var(--card-shift,0px))_calc(100%+3.75rem)] translate-x-[calc(-50%+var(--card-shift,0px))] overflow-y-auto rounded-3xl border border-white/15 bg-neutral-900 p-3.5 text-inherit shadow-[0_18px_60px_rgba(0,0,0,0.6)] transition-[scale,opacity] duration-300 ease-[cubic-bezier(0.2,0.9,0.3,1.08)] outline-none starting:scale-[0.3] starting:opacity-0 motion-reduce:starting:scale-100',
        'short:top-0 short:bottom-auto short:left-15 short:mb-0 short:grid short:w-[min(30rem,calc(100vw-2rem))] short:origin-[calc(-3.75rem-var(--card-shift,0px))_calc(0px-var(--card-y,0px))] short:translate-x-[var(--card-shift,0px)] short:translate-y-[var(--card-y,0px)] short:grid-cols-[1.2fr_1fr] short:items-center short:gap-x-4 short:p-3',
        leaving &&
          'scale-[0.3] opacity-0 duration-150 ease-in motion-reduce:scale-100',
      )}
    >
      {hero && prizes.length === 1 ? (
        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => sheets.zoom(hero)}
            aria-label={`See ${hero.title}, ${rmAuto(hero.value_myr)}`}
            className="relative block aspect-[5/7] w-[6.5rem] shrink-0 cursor-zoom-in rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-white/60 max-[359px]:w-20 short:w-[4.5rem]"
          >
            <FramedArt prize={hero} holo eager />
          </button>
          {header}
        </div>
      ) : (
        <div className="min-w-0">
          <div className="flex">{header}</div>
          <GatePrizes prizes={prizes} onZoom={sheets.zoom} />
        </div>
      )}

      <div className="min-w-0">
        <div className="mt-3 grid grid-cols-3 divide-x divide-white/10 border-t border-white/10 pt-3 short:mt-0 short:border-t-0 short:pt-0">
          <Stat label="Your tickets" short="Yours">
            {num(gate.my_tickets)}
          </Stat>
          <Stat label="Your chance" short="Chance">
            {chancePercent(gate.my_tickets, gate.total_tickets)}
          </Stat>
          <button
            type="button"
            onClick={() => sheets.players(gate)}
            aria-label={`Players: ${num(gate.entrant_count)}. See the top 10`}
            className="min-h-11 min-w-0 rounded-lg transition-colors outline-none hover:bg-white/5 focus-visible:ring-2 focus-visible:ring-white/60"
          >
            <Stat label="Players">
              {num(gate.entrant_count)}
              <ChevronRight
                className="ml-0.5 h-4 w-4 shrink-0 text-neutral-400"
                aria-hidden
              />
            </Stat>
          </button>
        </div>
        <div className="mt-3 short:mt-2">
          <GateAction
            gate={gate}
            closed={closed}
            nowMs={nowMs}
            balance={balance}
            spinHref={spinHref}
            onEnter={onEnter}
            onGetTickets={sheets.getTickets}
          />
        </div>
      </div>
    </dialog>
  );
}

/** The Pool tab as a globe: every running gate is a plane on its way to land,
 *  which is when its gate closes. A tap on a plane or its pin moves in and the
 *  pin grows into the gate's details. Without WebGL it is the list. */
export function GlobePool({
  gates,
  newIds,
  nowMs,
  balance,
  spinHref,
  onEnter,
}: {
  gates: LuckyDrawGate[];
  newIds: ReadonlySet<string>;
  nowMs: number | null;
  balance: number;
  /** Where to spin a capsule for tickets; null with none on sale. */
  spinHref: string | null;
  onEnter: (gate: LuckyDrawGate) => void;
}) {
  const reduced = usePrefersReducedMotion();
  const stage = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const scene = useRef<GlobeScene | null>(null);
  const spots = useRef(new Map<string, HTMLDivElement>());
  const card = useRef<HTMLDialogElement>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const [shown, setShown] = useState<{ id: string; leaving: boolean } | null>(
    null,
  );
  // The open card's height cap, as a CSS variable on the stage.
  const setMaxHeight = (px: number) =>
    stage.current?.style.setProperty('--card-max', `${px}px`);
  const sideways = useMediaQuery(SIDEWAYS);
  const sidewaysNow = useRef(sideways);
  useEffect(() => {
    sidewaysNow.current = sideways;
  }, [sideways]);
  const sheets = useGateSheets(spinHref);

  const open = useCallback((id: string | null) => {
    setShown((now) =>
      id ? { id, leaving: false } : now && { ...now, leaving: true },
    );
  }, []);
  // A gate drawn while its pin is open takes the pin with it.
  const openGate = (shown && gates.find((g) => g.id === shown.id)) || null;
  const openId = openGate && !shown?.leaving ? openGate.id : null;

  // Every frame: each pin to its plane, kept inside the stage.
  const onFrame = useCallback((anchors: readonly GlobeAnchor[]) => {
    const width = stage.current?.clientWidth ?? 0;
    const height = stage.current?.clientHeight ?? 0;
    for (const a of anchors) {
      const el = spots.current.get(a.id);
      if (!el) continue;
      el.style.transform = `translate3d(${a.x.toFixed(1)}px,${a.y.toFixed(1)}px,0)`;
      const hidden = a.hidden ? 'true' : 'false';
      if (el.dataset.hidden !== hidden) el.dataset.hidden = hidden;
      const dialog = el.querySelector<HTMLElement>('dialog');
      if (dialog && sidewaysNow.current) {
        // Beside the plane: as high as it fits round the plane's height, and
        // pulled left only if the right edge would leave the stage.
        const w = dialog.offsetWidth;
        const h = dialog.offsetHeight;
        const top = Math.min(
          Math.max(a.y - h / 2, EDGE),
          Math.max(EDGE, sideRoom(stage.current, height) - h - EDGE),
        );
        const right = a.x + SIDE_GAP + w;
        el.style.setProperty('--card-y', `${(top - a.y).toFixed(1)}px`);
        el.style.setProperty(
          '--card-shift',
          `${Math.min(0, width - EDGE - right).toFixed(1)}px`,
        );
      }
      for (const [selector, name] of [
        ['[data-pin]', '--pin-shift'],
        ['dialog', '--card-shift'],
      ] as const) {
        if (selector === 'dialog' && sidewaysNow.current) continue;
        const box = el.querySelector<HTMLElement>(selector);
        if (!box) continue;
        const half = box.offsetWidth / 2;
        const x = Math.min(
          Math.max(a.x, half + EDGE),
          Math.max(half + EDGE, width - half - EDGE),
        );
        el.style.setProperty(name, `${(x - a.x).toFixed(1)}px`);
      }
    }
  }, []);

  useEffect(() => {
    if (!host.current) return;
    let made: GlobeScene;
    try {
      made = createGlobeScene(host.current, {
        reducedMotion: reduced,
        onReady: () => setReady(true),
        onFail: () => setFailed(true),
        onFrame,
        onPick: open,
      });
    } catch {
      // Whether the GPU can draw is only known by asking it.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setFailed(true);
      return;
    }
    scene.current = made;
    return () => {
      made.dispose();
      scene.current = null;
    };
  }, [reduced, onFrame, open]);

  const ids = gates.map((g) => g.id).join('|');
  const routes = useMemo(() => assignRoutes(ids ? ids.split('|') : []), [ids]);
  useEffect(() => {
    if (nowMs == null) return;
    scene.current?.setFlights(
      gates.map((g) => ({
        id: g.id,
        kind: planeKind(g.tier as LuckyDrawTier | null),
        route: routes.get(g.id) ?? 0,
        progress: flightProgress(g.starts_at, g.ends_at, nowMs),
      })),
    );
  }, [gates, routes, nowMs, reduced]);

  // Move in on the open gate, its plane low enough for the pin to fit above.
  useEffect(() => {
    const fit = () => {
      const height = stage.current?.clientHeight ?? 0;
      if (!openId || !height) {
        scene.current?.focus(null);
        return;
      }
      if (sideways) {
        // The plane on the left, the grown pin beside it, both above the dock.
        const room = sideRoom(stage.current, height);
        setMaxHeight(room - 2 * EDGE);
        const width = stage.current?.clientWidth ?? 0;
        scene.current?.focus(openId, room * 0.62, width * 0.14);
        return;
      }
      // On a short stage the pin may rise over the tabs above it.
      const room = height - 44;
      setMaxHeight(room);
      const tall = Math.min(card.current?.scrollHeight ?? 320, room);
      scene.current?.focus(
        openId,
        Math.min(height - 44, Math.max(tall + STEM + 12, height * 0.7)),
      );
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [openId, reduced, sideways]);

  // The pin shrinks back, then goes; focus returns to where it came from.
  useEffect(() => {
    if (!shown?.leaving) return;
    const id = window.setTimeout(() => setShown(null), LEAVE_MS);
    return () => window.clearTimeout(id);
  }, [shown]);
  useEffect(() => {
    if (!openId) return;
    const pins = spots.current;
    card.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      // A sheet opened from the card (players, tickets) closes first, alone.
      // Read in the capture phase: the sheet's own document listener removes
      // it before a bubbling window listener would look.
      // Modal sheets only: the cookie banner is a dialog too, but not modal.
      if (e.key === 'Escape' && !document.querySelector('[aria-modal="true"]'))
        open(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      pins
        .get(openId)
        ?.querySelector<HTMLElement>('[data-pin]')
        ?.focus({ preventScroll: true });
    };
  }, [openId, open]);

  if (failed) {
    return (
      <GateList
        gates={gates}
        newIds={newIds}
        nowMs={nowMs}
        balance={balance}
        spinHref={spinHref}
        onEnter={onEnter}
      />
    );
  }

  const ordered = sortGates(gates, 'closing', newIds, nowMs);
  return (
    <div className="space-y-3">
      <div
        ref={stage}
        className={cn('relative isolate overflow-x-clip', GLOBE_STAGE)}
      >
        {!ready && (
          <div className="absolute inset-0 grid place-items-center" aria-hidden>
            <div className="aspect-square w-[min(72%,24rem)] animate-pulse rounded-full bg-white/[0.04]" />
          </div>
        )}
        <div
          ref={host}
          className={cn(
            'absolute inset-0 transition-opacity duration-500',
            ready ? 'opacity-100' : 'opacity-0',
          )}
        />

        <div
          className={cn(
            'pointer-events-none absolute top-0 left-0 z-10 transition-opacity duration-300',
            openId && 'opacity-0',
          )}
        >
          <p
            aria-hidden
            className="font-heading text-lg leading-none text-white lg:hidden"
          >
            LUCKY DRAW
          </p>
          <p className="mt-1.5 text-xs text-neutral-400 lg:mt-0">
            {num(gates.length)} prize {gates.length === 1 ? 'pool' : 'pools'} in
            the air · tap a plane
          </p>
        </div>

        {ready &&
          ordered.map((gate) => {
            const isOpen = shown?.id === gate.id;
            return (
              <div
                key={gate.id}
                ref={(el) => {
                  if (el) spots.current.set(gate.id, el);
                  else spots.current.delete(gate.id);
                }}
                data-hidden="true"
                className={cn(
                  'absolute top-0 left-0 h-0 w-0 transition-[opacity,visibility] duration-200 data-[hidden=true]:invisible data-[hidden=true]:opacity-0',
                  isOpen ? 'z-30' : 'z-20',
                  // One pin at a time: the rest step back while one is open.
                  // invisible too, so Tab can't land on a faded pin.
                  openId &&
                    !isOpen &&
                    'pointer-events-none invisible opacity-0',
                )}
              >
                {/* The stem: longer while the pin is open. */}
                <span
                  aria-hidden
                  className={cn(
                    'absolute bottom-1.5 left-0 w-px -translate-x-1/2 bg-white/60 transition-[height] duration-300',
                    isOpen && !shown?.leaving ? 'h-[3.4rem] short:h-0' : 'h-6',
                  )}
                />
                <span
                  aria-hidden
                  className="absolute -top-[3px] -left-[3px] h-1.5 w-1.5 rounded-full bg-white"
                />
                <Pin
                  gate={gate}
                  nowMs={nowMs}
                  isNew={newIds.has(gate.id)}
                  open={isOpen && !shown?.leaving}
                  onOpen={() => open(gate.id)}
                />
                {isOpen && (
                  <Detail
                    gate={gate}
                    nowMs={nowMs}
                    isNew={newIds.has(gate.id)}
                    leaving={shown?.leaving ?? false}
                    balance={balance}
                    spinHref={spinHref}
                    cardRef={card}
                    onClose={() => open(null)}
                    onEnter={() => onEnter(gate)}
                    sheets={sheets}
                  />
                )}
              </div>
            );
          })}
      </div>

      <HowItWorks at={balance > 0 ? 'enter' : 'collect'} className="pt-3" />
      {sheets.node}
    </div>
  );
}

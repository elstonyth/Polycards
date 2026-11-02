'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Image from 'next/image';
import Link from 'next/link';
import {
  ArrowLeft,
  ArrowUpRight,
  Check,
  ChevronsUp,
  Layers3,
} from 'lucide-react';
import { Pill, pillVariants } from '@/components/ui/pill';
import { cn } from '@/lib/utils';
import { CoinStage } from '@/components/coin-flip/CoinStage';
import { StaticCoin } from '@/components/coin-flip/StaticCoin';
import { VaultCardPicker } from '@/components/coin-flip/VaultCardPicker';
import { TicketStakePicker } from '@/components/coin-flip/TicketStakePicker';
import { TicketArt } from '@/components/TicketArt';
import { TicketCount } from '@/components/coin-flip/TicketCount';
import styles from '@/components/coin-flip/coin-flip.module.css';
import type { CoinGesture } from '@/lib/coin-motion';
import { CoinFlipHistory } from '@/components/coin-flip/CoinFlipHistory';
import { useTopUp } from '@/components/app-shell/TopUpProvider';
import { useModalA11y } from '@/lib/use-modal-a11y';
import { useSound } from '@/lib/use-sound';
import { useCountedValue } from '@/lib/use-counted-value';
import { getVault, type VaultResult } from '@/lib/actions/vault';
import { getTicketBalance } from '@/lib/actions/lucky-draw';
import {
  acceptCoinFlip,
  getCoinFlipRound,
  getCoinFlipSettings,
  quoteCoinFlip,
} from '@/lib/actions/coin-flip';
import {
  COIN_FLIP_QUOTE_MS,
  coinFlipPendingKey,
  coinFlipTicketsGone,
  coinFlipTicketsLabel,
  quoteIsLive,
  type CoinFlipRound,
  type CoinSide,
  coinSideLabel,
} from '@/lib/coin-flip';
import { num, rm } from '@/lib/format';

type Phase =
  | 'loading'
  | 'idle'
  | 'quoting'
  | 'confirm'
  | 'armed'
  | 'submitting'
  | 'recovering'
  | 'animating'
  | 'result';
type SettingsResult = Awaited<ReturnType<typeof getCoinFlipSettings>>;

export function CoinFlipClient({
  customerId,
  initialVault,
  initialSettings,
  initialPullId,
  initialTickets = null,
  initialStake = 'cards',
}: {
  customerId: string;
  initialVault: VaultResult;
  initialSettings: SettingsResult;
  initialPullId?: string | string[];
  /** Lucky Draw tickets held; null when unreadable, which hides adding them. */
  initialTickets?: number | null;
  initialStake?: 'cards' | 'tickets';
}) {
  const [vault, setVault] = useState(initialVault);
  const [settings, setSettings] = useState(initialSettings);
  const [tickets, setTickets] = useState(initialTickets);
  // Tickets going in on top of any cards. None until the player adds some.
  const [ticketStake, setTicketStake] = useState(
    initialStake === 'tickets' ? 1 : 0,
  );
  const [selected, setSelected] = useState<string[]>(
    initialPullId
      ? Array.isArray(initialPullId)
        ? initialPullId
        : [initialPullId]
      : [],
  );
  const [chosenSide, setChosenSide] = useState<CoinSide>('head');
  const [phase, setPhase] = useState<Phase>('loading');
  const [round, setRound] = useState<CoinFlipRound | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState(initialVault.ok ? '' : initialVault.error);
  const [now, setNow] = useState(0);
  // Device clock minus server clock: a phone running fast must not expire a live quote.
  const [clockSkew, setClockSkew] = useState(0);
  const [historyRevision, setHistoryRevision] = useState(0);
  // The result came from a toss made here, so it gets the light and sound.
  const [tossed, setTossed] = useState(false);
  const [motionProfile, setMotionProfile] = useState<CoinGesture>(0.5);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [dragReady, setDragReady] = useState(false);
  const finishMotion = useCallback(
    () => setPhase((p) => (p === 'animating' ? 'result' : p)),
    [],
  );
  const busy = useRef(false);
  const mounted = useRef(false);
  const unrevealedReceipt = useRef(false);
  const panel = useRef<HTMLDivElement>(null);
  const coinView = useRef<HTMLDivElement>(null);
  const resultPanel = useRef<HTMLDivElement>(null);
  const flipButton = useRef<HTMLButtonElement>(null);
  const reviewButton = useRef<HTMLButtonElement>(null);
  const { refreshBalance } = useTopUp();
  const { sfx, vibrate, duck } = useSound();
  const storageKey = coinFlipPendingKey(customerId);
  const items = vault.ok ? vault.items.filter((item) => !item.locked) : [];
  const selectedCards = items.filter((item) => selected.includes(item.pullId));
  const config = settings.ok ? settings.settings : null;
  const live = round ? quoteIsLive(round, now - clockSkew) : false;
  const status = round?.status;
  const locked = !['idle', 'result'].includes(phase);
  // The committed round on screen, or null while the stake is still being picked.
  const shownRound =
    round && !['idle', 'quoting', 'loading'].includes(phase) ? round : null;
  const ticketBalance = tickets ?? 0;
  // A loss can leave fewer tickets than the amount picked last time.
  const pickedTickets = Math.min(ticketStake, ticketBalance);
  const stakedTickets = shownRound ? shownRound.tickets : pickedTickets;
  const canReview = selectedCards.length > 0 || pickedTickets > 0;
  const focusReview = useRef(false);

  useModalA11y(panel, phase === 'confirm', () => setPhase('idle'));

  function showRoundInUrl(id: string | null) {
    const url = new URL(window.location.href);
    if (id) url.searchParams.set('round', id);
    else url.searchParams.delete('round');
    // Null state: Next keeps its own and follows the address, so a router.refresh()
    // keeps ?round= and Back restores the right entry.
    window.history.replaceState(null, '', url);
  }
  function clearPending(id: string, removeUrl = false) {
    try {
      if (localStorage.getItem(storageKey) === id)
        localStorage.removeItem(storageKey);
    } catch {
      /* URL still identifies the receipt. */
    }
    setPendingId(null);
    if (
      removeUrl &&
      new URLSearchParams(window.location.search).get('round') === id
    )
      showRoundInUrl(null);
  }
  function remember(id: string) {
    let saved = false;
    try {
      localStorage.setItem(storageKey, id);
      saved = true;
    } catch {
      /* Private browsing may disable storage. */
    }
    try {
      showRoundInUrl(id);
      saved = true;
    } catch {
      /* Local storage remains a recovery path. */
    }
    if (!saved) throw new Error('Cannot retain the round for recovery.');
    setPendingId(id);
  }
  function settled(receipt: CoinFlipRound, animate = false) {
    if (!mounted.current) {
      // Keep recovery for an unseen result that arrived after navigation.
      void refreshBalance().catch(() => {});
      return;
    }
    setRound(receipt);
    // A toss keeps recovery until it lands, so leaving mid-flight still finds the receipt.
    if (!animate) clearPending(receipt.id);
    else {
      // The stake has moved. Nothing on screen shows these until the stake is picked
      // again, and that must not offer a lost card, whatever the refresh returns.
      if (receipt.status === 'lost')
        setVault((held) =>
          held.ok
            ? {
                ...held,
                items: held.items.filter(
                  (item) =>
                    !receipt.cards.some((c) => c.pull_id === item.pullId),
                ),
              }
            : held,
        );
      setTickets((held) =>
        held === null
          ? held
          : held + (receipt.status === 'won' ? 1 : -1) * receipt.tickets,
      );
    }
    setError('');
    setPhase(animate ? 'animating' : 'result');
    setTossed(animate);
    unrevealedReceipt.current = animate;
    setHistoryRevision((value) => value + 1);
  }
  async function recover(id: string) {
    if (busy.current) return;
    busy.current = true;
    setPendingId(id);
    // "Resolve your previous flip" is for a real problem, not for opening a receipt.
    setPhase('loading');
    // A pending flip outranks the address it was opened from, so the two must agree.
    try {
      showRoundInUrl(id);
    } catch {
      /* Only the address is stale; the flip still opens. */
    }
    try {
      const response = await getCoinFlipRound(id);
      if (response.ok) {
        setRound(response.round);
        if (response.round.status !== 'quoted') settled(response.round);
        else {
          setPhase('recovering');
          setError(
            'This flip has no confirmed result yet. Retry the same flip to resolve it.',
          );
        }
      } else {
        if (response.missing) {
          clearPending(id, true);
          setRound(null);
          setPhase('idle');
        } else setPhase('recovering');
        setError(response.error);
      }
    } catch {
      setPhase('recovering');
      setError(
        'Connection interrupted. Your result is unknown. Check this flip again.',
      );
    } finally {
      busy.current = false;
    }
  }
  const refreshStake = useCallback(() => {
    // A failed read keeps what is on screen: it says nothing about the Vault.
    void getVault()
      .then((next) => {
        if (next.ok) setVault(next);
      })
      .catch(() => {});
    void getTicketBalance()
      .then((held) => setTickets((known) => held ?? known))
      .catch(() => {});
  }, []);
  useEffect(() => {
    // Back restores this page's old props, so only the address names the right flip,
    // and the Vault and tickets in those props can be from before a flip.
    let id = new URLSearchParams(window.location.search).get('round');
    try {
      id = localStorage.getItem(storageKey) || id;
    } catch {
      /* Use the receipt URL. */
    }
    let active = true;
    void Promise.resolve().then(() => {
      if (!active) return;
      refreshStake();
      if (id) void recover(id);
      else setPhase('idle');
    });
    return () => {
      active = false;
    };
    // Recovery is bound to this authenticated page mount, never to changing UI state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerId]);
  useEffect(() => {
    if (phase !== 'armed' && phase !== 'confirm') return;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [phase]);
  useEffect(() => {
    if (phase !== 'result') return;
    if (round?.id) {
      try {
        if (localStorage.getItem(storageKey) === round.id)
          localStorage.removeItem(storageKey);
      } catch {
        /* The receipt URL still identifies it. */
      }
    }
    // Only a toss made here gets the result cue; a reopened receipt stays quiet.
    const fromToss = unrevealedReceipt.current;
    unrevealedReceipt.current = false;
    resultPanel.current?.focus({ preventScroll: true });
    void refreshBalance().catch(() => {});
    refreshStake();
    void getCoinFlipSettings()
      .then((next) => {
        if (next.ok) setSettings(next);
      })
      .catch(() => {});
    if (!fromToss || (status !== 'won' && status !== 'lost')) return;
    sfx(status === 'won' ? 'coinWin' : 'coinLoss');
    vibrate(status === 'won' ? [16, 60, 28] : 10);
    // Hold the music bed down while the cue rings out, as the draw wheel does.
    duck(true);
    let held = true;
    const release = () => {
      if (held) duck(false);
      held = false;
    };
    const timer = window.setTimeout(release, 1600);
    return () => {
      window.clearTimeout(timer);
      release();
    };
  }, [
    phase,
    round?.id,
    status,
    storageKey,
    refreshBalance,
    refreshStake,
    sfx,
    vibrate,
    duck,
  ]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // Leaving during the toss must still sync the already-settled wallet.
      if (unrevealedReceipt.current) void refreshBalance().catch(() => {});
    };
  }, [refreshBalance]);
  useEffect(() => {
    if (phase === 'armed') {
      flipButton.current?.focus({ preventScroll: true });
      coinView.current?.scrollIntoView({ block: 'start', behavior: 'instant' });
    }
    if (phase === 'idle' && round) reviewButton.current?.focus();
    if (phase === 'idle' && focusReview.current) {
      focusReview.current = false;
      reviewButton.current?.focus({ preventScroll: true });
    }
  }, [phase, round]);
  useEffect(() => {
    if (
      !pickerOpen &&
      selected.length &&
      document.activeElement === document.body
    )
      reviewButton.current?.focus({ preventScroll: true });
  }, [pickerOpen, selected]);

  async function handleReview() {
    if (busy.current || locked || !canReview || !config?.eligible) return;
    busy.current = true;
    setPhase('quoting');
    setError('');
    try {
      const response = await quoteCoinFlip(
        selectedCards.map((card) => card.pullId),
        chosenSide,
        pickedTickets,
      );
      if (response.ok) {
        setRound(response.round);
        // A loss can have cut the amount on screen; this is the one being staked.
        setTicketStake(pickedTickets);
        // eslint-disable-next-line react-hooks/purity -- Runs after the quote request in the Review button's click handler.
        const arrived = Date.now();
        setNow(arrived);
        setClockSkew(
          arrived -
            (Date.parse(response.round.expires_at) - COIN_FLIP_QUOTE_MS),
        );
        setPhase('confirm');
      } else {
        setError(response.error);
        // A refusal usually means this page's picture of the Vault is out of date.
        refreshStake();
        setPhase('idle');
      }
    } catch {
      setError(
        `Could not load a quote. Your ${selectedCards.length ? 'cards' : 'tickets'} have not been committed.`,
      );
      setPhase('idle');
    } finally {
      busy.current = false;
    }
  }
  async function flip(retry = false, profile: CoinGesture = 0.5) {
    const id = retry ? pendingId : round?.id;
    if (
      busy.current ||
      !id ||
      (!retry &&
        (phase !== 'armed' ||
          !round ||
          !quoteIsLive(round, Date.now() - clockSkew)))
    )
      return;
    busy.current = true;
    setMotionProfile(profile);
    try {
      remember(id);
    } catch {
      setError('Enable browser storage before starting a flip.');
      busy.current = false;
      return;
    }
    setPhase('submitting');
    setError('');
    if (!retry)
      coinView.current?.scrollIntoView({
        block: 'start',
        behavior: 'instant',
      });
    try {
      const response = await acceptCoinFlip(id);
      if (response.ok && response.round.status !== 'quoted')
        settled(response.round, !retry);
      else if (!response.ok && !response.uncertain) {
        clearPending(id, true);
        setRound(null);
        setPhase('idle');
        setError(response.error);
        refreshStake();
      } else {
        setPhase('recovering');
        setError(
          'Your result is not confirmed yet. Check this flip before starting another.',
        );
      }
    } catch {
      setPhase('recovering');
      setError(
        'Connection interrupted. Your result is unknown. Check this flip again.',
      );
    } finally {
      busy.current = false;
    }
  }
  const receiptVisible = phase === 'result' && round;
  const outcome =
    round?.status === 'won' || round?.status === 'lost' ? round.status : null;
  // The won Credit counts up from zero as the receipt arrives.
  const { value: countedWin } = useCountedValue(
    receiptVisible && outcome === 'won' ? round.win_amount : 0,
  );
  const cards =
    round && !['idle', 'quoting', 'loading'].includes(phase)
      ? round.cards
      : selectedCards.map((item) => ({
          pull_id: item.pullId,
          name: item.card.name,
          image: item.card.slabImage || item.card.image,
          stake_amount: item.card.priceMyr,
        }));
  const value =
    round && !['idle', 'quoting', 'loading'].includes(phase)
      ? round.stake_amount
      : cards.length && cards.every((card) => card.stake_amount != null)
        ? cards.reduce(
            (sum, card) => sum + Math.round(card.stake_amount! * 100),
            0,
          ) / 100
        : null;
  const call =
    round && !['idle', 'quoting', 'loading'].includes(phase)
      ? round.chosen_side
      : chosenSide;
  function chooseAnother() {
    if (round) clearPending(round.id, true);
    setPhase('idle');
    setRound(null);
    setSelected([]);
    setTicketStake(0);
    setError('');
    setPickerOpen(true);
  }
  function chooseTicketAmount() {
    if (round) clearPending(round.id, true);
    setRound(null);
    setError('');
    focusReview.current = true;
    setPhase('idle');
  }
  // A win keeps the stake, so the same cards, tickets and call go straight back up
  // for review. The spent quote is never reused: Review quotes them afresh, and the
  // Confirm step still stands between here and another toss. Tickets come back at
  // the amount just flipped, never the doubled balance.
  const canFlipAgain =
    outcome === 'won' &&
    config?.eligible === true &&
    round !== null &&
    ticketBalance >= round.tickets &&
    round.cards.every((card) =>
      items.some((item) => item.pullId === card.pull_id),
    );
  function flipAgain() {
    if (!round) return;
    clearPending(round.id, true);
    setChosenSide(round.chosen_side);
    setTicketStake(round.tickets);
    setSelected(round.cards.map((card) => card.pull_id));
    setRound(null);
    setError('');
    focusReview.current = true;
    setPhase('idle');
  }

  // In place, so a row already in the address still opens: a link to it would not.
  function openRound(id: string) {
    setPickerOpen(false);
    window.scrollTo({ top: 0, behavior: 'instant' });
    void recover(id);
  }

  const landed = receiptVisible ? round.landed_side : null;
  const armedLive = phase === 'armed' && live;
  const otherSide = call === 'head' ? 'tail' : 'head';
  // What each side pays is review copy: once tossed it would read as a result before the coin lands.
  const beforeToss = ['idle', 'quoting', 'confirm', 'armed'].includes(phase);
  const chooseFromVault = (className: string) => (
    <button
      disabled={locked || !items.length}
      onClick={() => setPickerOpen(true)}
      className={`flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-white/25 px-4 py-5 text-sm text-neutral-200 transition-colors hover:border-white/60 hover:bg-white/5 focus-visible:outline-2 focus-visible:outline-white disabled:opacity-50 ${className}`}
    >
      <Layers3 size={26} strokeWidth={1.3} aria-hidden />
      <span className="font-semibold">Choose from Vault</span>
      <span className="text-xs text-neutral-400">
        {items.length} available {items.length === 1 ? 'card' : 'cards'}
      </span>
    </button>
  );
  const ticketsOnly = stakedTickets > 0 && cards.length === 0;
  const ticketStakeView = shownRound
    ? stakedTickets > 0 && (
        <div className="flex items-center gap-3">
          <div
            key={receiptVisible ? shownRound.id : 'committed'}
            className={`relative shrink-0 ${styles.cardArt}`}
          >
            <TicketArt width={64} />
            <span aria-hidden className={styles.sweep} />
          </div>
          <div className="min-w-0">
            <p className="font-display text-lg font-black tabular-nums">
              <TicketCount tickets={stakedTickets} art={false} />
            </p>
            <p className="mt-0.5 text-xs text-neutral-400">
              {phase !== 'result'
                ? 'Lucky Draw tickets'
                : outcome === 'won'
                  ? `Kept, plus ${num(stakedTickets)} more`
                  : 'Gone from your tickets'}
            </p>
          </div>
        </div>
      )
    : ticketBalance > 0 && (
        <TicketStakePicker
          balance={ticketBalance}
          value={pickedTickets}
          disabled={phase !== 'idle'}
          onChange={setTicketStake}
        />
      );

  return (
    <>
      <header className="mb-4 flex items-end justify-between gap-4 sm:mb-6">
        <div className="min-w-0">
          <h1 className="font-display text-3xl font-black tracking-tight text-balance">
            Coin flip
          </h1>
          <p className="mt-1 text-sm text-neutral-400">
            Your cards. Your call. One toss.
          </p>
        </div>
        <Link
          href="/vault"
          className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-lg px-2 text-sm text-neutral-300 hover:text-white focus-visible:outline-2 focus-visible:outline-white"
        >
          <ArrowLeft size={16} aria-hidden /> Vault
        </Link>
      </header>
      <div
        className={`overflow-hidden rounded-2xl border border-white/10 bg-neutral-900 ${receiptVisible ? (outcome === 'won' ? styles.won : styles.lost) : ''}`}
      >
        <div className="grid lg:grid-cols-[minmax(0,1fr)_288px]">
          <div className="flex min-w-0 flex-col">
            <div ref={coinView} className="scroll-mt-20">
              {/* A fixed height keeps the camera framing steady through the toss. */}
              <div
                className={`relative h-[clamp(220px,34svh,320px)] lg:h-[440px] ${styles.stage}`}
              >
                <CoinStage
                  armed={armedLive}
                  pending={phase === 'submitting'}
                  revealed={phase === 'result' && tossed}
                  outcome={outcome}
                  side={round?.landed_side ?? call}
                  playbackId={
                    phase === 'animating' ? (round?.id ?? null) : null
                  }
                  profile={motionProfile}
                  onFlick={(profile) => void flip(false, profile)}
                  onComplete={finishMotion}
                  onReadyChange={setDragReady}
                />
                <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-start justify-between gap-2 p-3 sm:p-4">
                  <SideTag label="Your call" side={call} />
                  {landed && (
                    <SideTag
                      label="Landed"
                      side={landed}
                      landed
                      className={styles.landedIn}
                    />
                  )}
                </div>
                {armedLive && dragReady && (
                  <p className="pointer-events-none absolute inset-x-0 bottom-3 z-10 flex justify-center sm:bottom-4">
                    <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-black/60 px-3 py-1.5 text-xs font-medium text-neutral-200">
                      <ChevronsUp
                        size={14}
                        aria-hidden
                        className={styles.nudge}
                      />
                      Drag the coin up to toss
                    </span>
                  </p>
                )}
                {receiptVisible && (
                  <div
                    key={round.id}
                    aria-hidden
                    className={
                      outcome === 'won' ? styles.winPulse : styles.lossPulse
                    }
                  />
                )}
              </div>
              <section
                aria-label={
                  ticketsOnly ? 'Tickets in this flip' : 'Cards in this flip'
                }
                className="border-t border-white/10 px-4 pt-3 lg:hidden"
              >
                {cards.length > 0 ? (
                  <>
                    <div className="flex min-h-8 flex-wrap items-center justify-between gap-x-3">
                      <h2 className="min-w-0 text-sm font-semibold tabular-nums [overflow-wrap:anywhere]">
                        {cards.length} {cards.length === 1 ? 'card' : 'cards'}
                        <span aria-hidden className="mx-2 text-neutral-600">
                          ·
                        </span>
                        <span className="font-display">
                          {value == null ? 'Value on review' : rm(value)}
                        </span>
                      </h2>
                      {phase === 'idle' && (
                        <button
                          onClick={() => setPickerOpen(true)}
                          className="-mr-2 min-h-11 rounded-lg px-2 text-sm text-neutral-300 underline underline-offset-4 hover:text-white focus-visible:outline-2 focus-visible:outline-white"
                        >
                          Edit selection
                        </button>
                      )}
                    </div>
                    <ul
                      aria-label="Selected card thumbnails"
                      className="-mx-4 flex snap-x gap-3 overflow-x-auto overscroll-x-contain px-4 pt-1 pb-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
                    >
                      {cards.map((card) => (
                        <li
                          key={card.pull_id}
                          className="flex w-40 shrink-0 snap-start items-center gap-2.5"
                        >
                          <div
                            key={`${card.pull_id}:${receiptVisible ? round.id : 'selected'}`}
                            className={`relative h-16 w-12 shrink-0 overflow-hidden ${styles.cardArt}`}
                          >
                            <Image
                              src={
                                card.image ||
                                '/images/app/polycards-card-back.webp'
                              }
                              alt=""
                              fill
                              sizes="48px"
                              unoptimized
                              className="object-contain"
                            />
                            <span aria-hidden className={styles.sweep} />
                          </div>
                          <div className="min-w-0">
                            <p className="line-clamp-2 text-xs font-medium leading-snug [overflow-wrap:anywhere]">
                              {card.name}
                            </p>
                            <p className="mt-1 text-xs tabular-nums text-neutral-400 [overflow-wrap:anywhere]">
                              {card.stake_amount == null
                                ? 'Value on review'
                                : rm(card.stake_amount)}
                            </p>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </>
                ) : (
                  !shownRound && chooseFromVault('mb-3 w-full')
                )}
                {ticketStakeView && (
                  <div className="-mx-4 border-t border-white/10 px-4 py-3 first:border-t-0 first:pt-0">
                    {ticketStakeView}
                  </div>
                )}
              </section>
            </div>
            <div className="relative z-10 border-t border-white/10 p-4 sm:px-5 lg:py-5">
              {receiptVisible ? (
                <div
                  ref={resultPanel}
                  tabIndex={-1}
                  role="status"
                  className={`outline-none ${styles.receipt}`}
                >
                  <p className="flex items-center gap-2 text-xs text-neutral-300">
                    {outcome === 'won' && <Check size={14} aria-hidden />}
                    {coinSideLabel(round.landed_side!)} landed ·{' '}
                    {outcome === 'won' ? 'You won' : 'Flip lost'}
                  </p>
                  <h2
                    className={`mt-1.5 font-display text-3xl font-black tabular-nums [overflow-wrap:anywhere] lg:text-4xl ${outcome === 'won' ? 'text-buyback-fg' : 'text-white'}`}
                  >
                    {round.cards.length === 0 ? (
                      outcome === 'won' ? (
                        <>
                          +<TicketCount tickets={round.tickets} />
                        </>
                      ) : (
                        <>
                          <TicketCount tickets={round.tickets} /> lost
                        </>
                      )
                    ) : outcome === 'won' ? (
                      <>
                        {/* Screen readers get the final figure once, not every step of the count. */}
                        <span aria-hidden>
                          +{rm(countedWin ?? round.win_amount)}
                        </span>
                        <span className="sr-only">+{rm(round.win_amount)}</span>
                      </>
                    ) : cards.length === 1 ? (
                      'Card forfeited'
                    ) : (
                      'Cards forfeited'
                    )}
                  </h2>
                  {round.cards.length > 0 && round.tickets > 0 && (
                    <p
                      className={`mt-0.5 font-display text-lg font-black tabular-nums ${outcome === 'won' ? 'text-buyback-fg' : 'text-white'}`}
                    >
                      {outcome === 'won' ? (
                        <>
                          +<TicketCount tickets={round.tickets} />
                        </>
                      ) : (
                        <>
                          <TicketCount tickets={round.tickets} /> lost
                        </>
                      )}
                    </p>
                  )}
                  <div className="mt-1.5 flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between lg:gap-5">
                    <p className="max-w-prose text-xs leading-relaxed text-neutral-300">
                      {round.cards.length > 0 &&
                        (outcome === 'won'
                          ? `Added to your withdrawable Credit. ${round.cards.length === 1 ? 'Your card stays' : 'Every selected card stays'} in your Vault.`
                          : `${round.cards.length === 1 ? 'Your card has' : 'All selected cards have'} left your Vault. No Credit was added.`)}
                      {round.cards.length > 0 && round.tickets > 0 && ' '}
                      {round.tickets > 0 &&
                        (outcome === 'won'
                          ? 'Your tickets stay yours, and the same number again is added.'
                          : `${coinFlipTicketsGone(round.tickets)} Tickets you did not flip are safe.`)}
                      {canFlipAgain && (
                        <>
                          {' '}
                          <Link
                            href={
                              round.cards.length === 0
                                ? '/lucky-draw?open=1'
                                : '/transactions'
                            }
                            className="font-semibold whitespace-nowrap text-white underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-white/60"
                          >
                            {round.cards.length === 0
                              ? 'Open Lucky Draw'
                              : 'View wallet'}
                          </Link>
                        </>
                      )}
                    </p>
                    <div className="flex items-center gap-2 lg:shrink-0">
                      {canFlipAgain && (
                        <Pill
                          size="lg"
                          variant="secondary"
                          className="flex-1 lg:flex-none"
                          onClick={flipAgain}
                        >
                          Flip again
                        </Pill>
                      )}
                      {round.cards.length === 0 && ticketBalance > 0 ? (
                        <Pill
                          size="lg"
                          className="flex-1 lg:flex-none"
                          onClick={chooseTicketAmount}
                        >
                          Choose amount
                        </Pill>
                      ) : (
                        <Pill
                          size="lg"
                          className="flex-1 lg:flex-none"
                          onClick={chooseAnother}
                        >
                          Choose cards
                        </Pill>
                      )}
                      {!canFlipAgain && (
                        <Link
                          href={
                            round.cards.length === 0
                              ? '/lucky-draw?open=1'
                              : '/transactions'
                          }
                          className={cn(
                            pillVariants({ variant: 'ghost', size: 'lg' }),
                            'flex-1 lg:flex-none',
                          )}
                        >
                          {round.cards.length === 0
                            ? 'Lucky Draw'
                            : 'View wallet'}{' '}
                          <ArrowUpRight size={15} aria-hidden />
                        </Link>
                      )}
                    </div>
                  </div>
                </div>
              ) : phase === 'recovering' ? (
                <div aria-live="polite">
                  <h2 className="text-lg font-bold">
                    Resolve your previous flip
                  </h2>
                  <p className="mt-1 text-xs leading-relaxed text-neutral-300">
                    Nothing new can be committed while this result is uncertain.
                  </p>
                  <div className="mt-4 flex flex-col gap-2 sm:flex-row">
                    <Pill
                      size="lg"
                      className="w-full sm:w-auto sm:min-w-44"
                      onClick={() => pendingId && void recover(pendingId)}
                    >
                      Check result
                    </Pill>
                    {round?.status === 'quoted' && (
                      <Pill
                        variant="secondary"
                        size="lg"
                        className="w-full sm:w-auto sm:min-w-44"
                        onClick={() => void flip(true)}
                      >
                        Retry same flip
                      </Pill>
                    )}
                  </div>
                </div>
              ) : phase === 'armed' ? (
                <div
                  aria-live="polite"
                  className="flex flex-col gap-3 lg:flex-row lg:items-center lg:gap-5"
                >
                  <div className="min-w-0 lg:flex-1">
                    <p className="text-sm font-semibold">
                      {live
                        ? `Ready · ${coinSideLabel(call)} wins`
                        : 'Quote expired'}
                    </p>
                    <p className="mt-0.5 text-xs leading-relaxed text-neutral-400">
                      {live
                        ? dragReady
                          ? 'Drag the coin up and let go, or tap Flip coin.'
                          : 'Tap Flip coin to toss.'
                        : 'Review again for a fresh value.'}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Pill
                      ref={flipButton}
                      size="lg"
                      className="flex-1 lg:w-40 lg:flex-none"
                      disabled={!live}
                      // The coin's own flick sound plays as it leaves the hand.
                      data-sound="off"
                      onClick={() => void flip()}
                    >
                      Flip coin
                    </Pill>
                    <Pill
                      variant="secondary"
                      size="lg"
                      onClick={() => setPhase('idle')}
                    >
                      {live ? 'Cancel' : 'Review again'}
                    </Pill>
                  </div>
                </div>
              ) : ['submitting', 'loading', 'animating'].includes(phase) ? (
                <div className="flex min-h-12 items-center justify-between gap-3">
                  <p role="status" className="text-sm text-neutral-300">
                    {phase === 'loading'
                      ? 'Checking previous flips…'
                      : phase === 'animating'
                        ? 'Coin in flight…'
                        : 'Confirming your flip…'}
                  </p>
                  {phase === 'animating' && (
                    <button
                      className="min-h-11 px-1 text-sm font-semibold text-white underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-white"
                      onClick={finishMotion}
                    >
                      Skip animation
                    </button>
                  )}
                </div>
              ) : (
                <>
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:gap-5">
                    <fieldset
                      disabled={phase !== 'idle'}
                      className="min-w-0 lg:flex-1"
                    >
                      <legend className="mb-2 text-xs text-neutral-400">
                        Call the side you think will land
                      </legend>
                      <div className="relative grid grid-cols-2 rounded-full border border-white/10 bg-neutral-950 p-1">
                        <span
                          aria-hidden
                          className={`absolute inset-y-1 left-1 w-[calc(50%-0.25rem)] rounded-full bg-neutral-50 transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none ${call === 'tail' ? 'translate-x-full' : ''}`}
                        />
                        {(['head', 'tail'] as const).map((side) => (
                          <label
                            key={side}
                            className={`relative flex h-14 cursor-pointer items-center justify-center gap-2.5 rounded-full text-sm font-semibold transition-colors has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-white ${call === side ? 'text-neutral-950' : 'text-neutral-300 hover:text-white'}`}
                          >
                            <input
                              type="radio"
                              name="coin-side"
                              value={side}
                              checked={call === side}
                              onChange={() => setChosenSide(side)}
                              className="sr-only"
                            />
                            <StaticCoin side={side} className="size-10" />
                            {coinSideLabel(side)}
                          </label>
                        ))}
                      </div>
                    </fieldset>
                    <Pill
                      ref={reviewButton}
                      size="lg"
                      className="w-full lg:w-48"
                      disabled={!canReview || !config?.eligible || locked}
                      onClick={handleReview}
                    >
                      {phase === 'quoting'
                        ? 'Getting quote…'
                        : pickedTickets > 0
                          ? selectedCards.length > 0
                            ? 'Review flip'
                            : 'Review tickets'
                          : 'Review cards'}
                    </Pill>
                  </div>
                  {!items.length && ticketBalance === 0 && (
                    <p className="mt-3 text-xs text-neutral-400">
                      You need an unlocked card in your Vault to flip.
                    </p>
                  )}
                  {config && !config.eligible && (
                    <p className="mt-3 text-xs text-neutral-300">
                      {config.reason}
                    </p>
                  )}
                  {!settings.ok && (
                    <p role="alert" className="mt-3 text-xs text-red-300">
                      {settings.error}
                    </p>
                  )}
                </>
              )}
              {error && (
                <p
                  role="alert"
                  className="mt-3 text-xs leading-relaxed text-red-300"
                >
                  {error}
                </p>
              )}
            </div>
          </div>
          <section
            aria-label={ticketsOnly ? 'Selected tickets' : 'Selected cards'}
            className="relative hidden min-w-0 border-l border-white/10 lg:block"
          >
            {/* Absolute so a long card list scrolls instead of stretching the table. */}
            <div className="absolute inset-0 flex flex-col p-5">
              <div className="flex min-h-8 items-center justify-between gap-2">
                <h2 className="text-sm font-semibold">
                  {ticketsOnly ? 'Your tickets' : 'Your cards'}
                  {cards.length > 0 && (
                    <span className="text-neutral-400"> · {cards.length}</span>
                  )}
                </h2>
                {cards.length > 0 && phase === 'idle' && (
                  <button
                    onClick={() => setPickerOpen(true)}
                    className="min-h-9 rounded-md px-1 text-xs text-neutral-300 underline underline-offset-4 hover:text-white focus-visible:outline-2 focus-visible:outline-white"
                  >
                    Edit selection
                  </button>
                )}
              </div>
              {cards.length > 0 ? (
                <>
                  <ul className="-mr-2 mt-3 mb-4 min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain pr-2 [color-scheme:dark] [scrollbar-width:thin]">
                    {cards.map((card) => (
                      <li
                        key={card.pull_id}
                        className="flex items-center gap-3"
                      >
                        <div
                          key={`${card.pull_id}:${receiptVisible ? round.id : 'selected'}`}
                          className={`relative h-20 w-[60px] shrink-0 overflow-hidden ${styles.cardArt}`}
                        >
                          <Image
                            src={
                              card.image ||
                              '/images/app/polycards-card-back.webp'
                            }
                            alt={card.name}
                            fill
                            sizes="60px"
                            unoptimized
                            className="object-contain"
                          />
                          <span aria-hidden className={styles.sweep} />
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm font-semibold leading-snug [overflow-wrap:anywhere]">
                            {card.name}
                          </p>
                          <p className="mt-0.5 text-xs text-neutral-400">
                            {phase === 'result'
                              ? outcome === 'won'
                                ? 'Kept in your Vault'
                                : 'Removed from your Vault'
                              : round && locked
                                ? 'Confirmed card value'
                                : 'Market value'}
                          </p>
                          <p className="mt-1 text-sm font-semibold tabular-nums [overflow-wrap:anywhere]">
                            {card.stake_amount == null
                              ? 'Quote on review'
                              : rm(card.stake_amount)}
                          </p>
                        </div>
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                !shownRound && chooseFromVault('mt-3 mb-4 flex-1')
              )}
              {ticketStakeView && (
                <div className="mt-3 mb-4">{ticketStakeView}</div>
              )}
              {(cards.length > 0 || stakedTickets > 0) && (
                <div className="mt-auto border-t border-white/10 pt-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                    <span className="text-xs text-neutral-400">
                      Total stake
                    </span>
                    <strong className="min-w-0 font-display text-2xl tabular-nums [overflow-wrap:anywhere]">
                      {ticketsOnly ? (
                        <TicketCount tickets={stakedTickets} />
                      ) : value == null ? (
                        'On review'
                      ) : (
                        rm(value)
                      )}
                    </strong>
                    {!ticketsOnly && stakedTickets > 0 && (
                      <span className="w-full text-right text-sm font-semibold tabular-nums">
                        + <TicketCount tickets={stakedTickets} />
                      </span>
                    )}
                  </div>
                  {beforeToss && (
                    <dl className="mt-3 space-y-2 text-xs">
                      <div className="flex justify-between gap-3">
                        <dt className="text-neutral-400">
                          {coinSideLabel(call)} lands
                        </dt>
                        <dd className="text-right text-buyback-fg [overflow-wrap:anywhere]">
                          {ticketsOnly ? (
                            <>
                              +<TicketCount tickets={stakedTickets} />
                            </>
                          ) : (
                            <>
                              Keep cards +{' '}
                              {value != null ? rm(value) : 'their value'}
                              {stakedTickets > 0 && (
                                <>
                                  {' '}
                                  + <TicketCount tickets={stakedTickets} />
                                </>
                              )}
                            </>
                          )}
                        </dd>
                      </div>
                      <div className="flex justify-between gap-3">
                        <dt className="text-neutral-400">
                          {coinSideLabel(otherSide)} lands
                        </dt>
                        <dd className="text-right">
                          {ticketsOnly ? (
                            <>
                              <TicketCount tickets={stakedTickets} /> lost
                            </>
                          ) : stakedTickets > 0 ? (
                            <>
                              All cards and{' '}
                              <TicketCount tickets={stakedTickets} /> lost
                            </>
                          ) : (
                            'All cards forfeited'
                          )}
                        </dd>
                      </div>
                    </dl>
                  )}
                </div>
              )}
            </div>
          </section>
        </div>
      </div>
      <details className="mt-5 text-xs text-neutral-400">
        <summary className="min-h-11 cursor-pointer py-3 text-neutral-300">
          How this flip works
        </summary>
        <p className="max-w-2xl pb-3 leading-relaxed">
          Choose up to 20 cards and call Head (emblem) or Tail (wordmark). One
          flip decides the whole selection. A win pays 100% of the combined
          confirmed value as withdrawable Credit and keeps every card. A loss
          permanently forfeits every selected card. Bonus and gift-funded cards
          are included. Standard account and withdrawal checks still apply. Drag
          distance and release speed change how the coin flies, never the
          result.
        </p>
        <p className="max-w-2xl pb-3 leading-relaxed">
          You can add Lucky Draw tickets, with or without cards: pick how many.
          A win adds the same number again. A loss takes every ticket you put
          in. Tickets you did not add are safe, and tickets never pay Credit.
        </p>
      </details>
      <CoinFlipHistory
        refresh={receiptVisible ? historyRevision : 0}
        paused={phase === 'submitting' || phase === 'animating'}
        onOpen={openRound}
      />
      {pickerOpen && phase === 'idle' && (
        <VaultCardPicker
          items={items}
          selected={selected}
          onClose={() => setPickerOpen(false)}
          onSelect={(id) => {
            setSelected(id);
            setRound(null);
            setError('');
            setPickerOpen(false);
          }}
        />
      )}
      {phase === 'confirm' &&
        round &&
        createPortal(
          <div className="fixed inset-0 z-[110] flex items-end justify-center sm:items-center sm:p-4">
            <button
              aria-hidden
              tabIndex={-1}
              onClick={() => setPhase('idle')}
              className="glass-stage absolute inset-0 bg-black/80"
            />
            <div
              ref={panel}
              role="dialog"
              aria-modal="true"
              aria-labelledby="flip-confirm-title"
              tabIndex={-1}
              className="relative max-h-[90dvh] w-full overflow-y-auto rounded-t-2xl border border-white/15 bg-neutral-950 p-5 pb-[max(1.5rem,env(safe-area-inset-bottom))] outline-none sm:max-w-md sm:rounded-2xl sm:p-6"
            >
              <SideTag label="Your call" side={round.chosen_side} />
              <h2
                id="flip-confirm-title"
                className="mt-4 font-display text-2xl font-black text-balance"
              >
                Put{' '}
                {round.cards.length > 0 &&
                  (round.cards.length === 1
                    ? 'this card'
                    : `these ${round.cards.length} cards`)}
                {round.cards.length > 0 && round.tickets > 0 && ' and '}
                {round.tickets > 0 && coinFlipTicketsLabel(round.tickets)} on
                the line?
              </h2>
              <ul className="mt-4 max-h-44 space-y-2.5 overflow-y-auto overscroll-contain [color-scheme:dark] [scrollbar-width:thin]">
                {round.cards.map((card) => (
                  <li key={card.pull_id} className="flex items-center gap-3">
                    <Image
                      src={card.image || '/images/app/polycards-card-back.webp'}
                      alt=""
                      width={48}
                      height={64}
                      unoptimized
                      className="h-16 w-12 shrink-0 object-contain"
                    />
                    <div className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                      <p className="text-sm font-semibold leading-snug">
                        {card.name}
                      </p>
                      <p className="mt-0.5 text-sm tabular-nums text-neutral-300">
                        {rm(card.stake_amount)}
                      </p>
                    </div>
                  </li>
                ))}
                {round.tickets > 0 && (
                  <li className="flex items-center gap-3">
                    <TicketArt width={48} className="shrink-0" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold leading-snug">
                        Lucky Draw tickets
                      </p>
                      <p className="mt-0.5 text-sm tabular-nums text-neutral-300">
                        <TicketCount tickets={round.tickets} art={false} />
                      </p>
                    </div>
                  </li>
                )}
              </ul>
              <p className="mt-4 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-t border-white/10 pt-4 text-sm text-neutral-400">
                Total stake{' '}
                <strong className="min-w-0 font-display text-3xl tabular-nums text-white [overflow-wrap:anywhere]">
                  {round.cards.length > 0 ? (
                    rm(round.stake_amount)
                  ) : (
                    <TicketCount tickets={round.tickets} />
                  )}
                  {round.cards.length > 0 && round.tickets > 0 && (
                    <span className="block text-right text-base">
                      + <TicketCount tickets={round.tickets} />
                    </span>
                  )}
                </strong>
              </p>
              <ul className="mt-4 divide-y divide-white/10 rounded-xl border border-white/10 text-sm [overflow-wrap:anywhere]">
                <li className="flex items-start gap-3 p-3">
                  <StaticCoin
                    side={round.chosen_side}
                    className="size-9 shrink-0"
                  />
                  <div className="min-w-0">
                    <p className="text-xs text-neutral-400">
                      If {coinSideLabel(round.chosen_side)} lands
                    </p>
                    {round.cards.length > 0 && (
                      <p className="mt-0.5">
                        {round.cards.length === 1
                          ? 'Keep this card'
                          : 'Keep all selected cards'}{' '}
                        +{' '}
                        <strong className="text-buyback-fg">
                          {rm(round.stake_amount)} withdrawable Credit
                        </strong>
                      </p>
                    )}
                    {round.tickets > 0 && (
                      <p className="mt-0.5">
                        Keep your tickets +{' '}
                        <strong className="text-buyback-fg">
                          <TicketCount tickets={round.tickets} /> more
                        </strong>
                      </p>
                    )}
                  </div>
                </li>
                <li className="flex items-start gap-3 p-3">
                  <StaticCoin
                    side={round.chosen_side === 'head' ? 'tail' : 'head'}
                    className="size-9 shrink-0"
                  />
                  <div className="min-w-0">
                    <p className="text-xs text-neutral-400">
                      If{' '}
                      {coinSideLabel(
                        round.chosen_side === 'head' ? 'tail' : 'head',
                      )}{' '}
                      lands
                    </p>
                    {round.cards.length > 0 && (
                      <p className="mt-0.5 text-red-300">
                        {round.cards.length === 1
                          ? 'This card is'
                          : 'Every selected card is'}{' '}
                        permanently forfeited. No Credit.
                      </p>
                    )}
                    {round.tickets > 0 && (
                      <p className="mt-0.5 text-red-300">
                        {coinFlipTicketsGone(round.tickets)} Tickets you did not
                        flip are safe.
                      </p>
                    )}
                  </div>
                </li>
              </ul>
              {!live && (
                <p className="mt-4 text-xs text-neutral-400">
                  This quote expired. Close and review your{' '}
                  {round.cards.length > 0 ? 'cards' : 'tickets'} again.
                </p>
              )}
              <div className="mt-5 flex gap-3">
                <Pill
                  variant="secondary"
                  size="lg"
                  className="px-5"
                  onClick={() => setPhase('idle')}
                >
                  Cancel
                </Pill>
                <Pill
                  size="lg"
                  className="h-auto min-h-12 min-w-0 flex-1 py-2 leading-tight whitespace-normal"
                  disabled={!live}
                  onClick={() => setPhase('armed')}
                >
                  Confirm{' '}
                  {[
                    round.cards.length === 1
                      ? 'card'
                      : round.cards.length > 1 && `${round.cards.length} cards`,
                    round.tickets > 0 && coinFlipTicketsLabel(round.tickets),
                  ]
                    .filter(Boolean)
                    .join(' + ')}{' '}
                  · {coinSideLabel(round.chosen_side)}
                </Pill>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

// "Your call" and "Landed" read side by side over the table; the landed face is
// inverted so the outcome never looks like the choice.
function SideTag({
  label,
  side,
  landed = false,
  className = '',
}: {
  label: string;
  side: CoinSide;
  landed?: boolean;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full border py-1 pr-3.5 pl-1 ${landed ? 'border-white bg-neutral-50 text-neutral-950' : 'border-white/15 bg-black/65 text-white'} ${className}`}
    >
      <StaticCoin side={side} className="size-7" />
      <span className="flex flex-col leading-none">
        <span
          className={`text-[11px] font-medium ${landed ? 'text-neutral-600' : 'text-neutral-400'}`}
        >
          {label}
        </span>
        <span className="sr-only">: </span>
        <span className="mt-0.5 text-sm font-semibold">
          {coinSideLabel(side)}
        </span>
      </span>
    </span>
  );
}

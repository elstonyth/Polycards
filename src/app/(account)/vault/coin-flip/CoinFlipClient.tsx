'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Image from 'next/image';
import Link from 'next/link';
import { ArrowLeft, ArrowUpRight, ArrowUp, Check, Layers3 } from 'lucide-react';
import { Pill } from '@/components/ui/pill';
import { CoinStage } from '@/components/coin-flip/CoinStage';
import { VaultCardPicker } from '@/components/coin-flip/VaultCardPicker';
import styles from '@/components/coin-flip/coin-flip.module.css';
import type { CoinGesture } from '@/lib/coin-motion';
import { CoinFlipHistory } from '@/components/coin-flip/CoinFlipHistory';
import { useTopUp } from '@/components/app-shell/TopUpProvider';
import { useModalA11y } from '@/lib/use-modal-a11y';
import { getVault, type VaultResult } from '@/lib/actions/vault';
import {
  acceptCoinFlip,
  getCoinFlipRound,
  getCoinFlipSettings,
  quoteCoinFlip,
} from '@/lib/actions/coin-flip';
import {
  coinFlipPendingKey,
  quoteIsLive,
  type CoinFlipRound,
} from '@/lib/coin-flip';
import { rm } from '@/lib/format';

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
  initialRoundId,
}: {
  customerId: string;
  initialVault: VaultResult;
  initialSettings: SettingsResult;
  initialPullId?: string;
  initialRoundId?: string;
}) {
  const [vault, setVault] = useState(initialVault);
  const [settings, setSettings] = useState(initialSettings);
  const [selected, setSelected] = useState(initialPullId ?? '');
  const [phase, setPhase] = useState<Phase>('loading');
  const [round, setRound] = useState<CoinFlipRound | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState(initialVault.ok ? '' : initialVault.error);
  const [now, setNow] = useState(0);
  const [historyRevision, setHistoryRevision] = useState(0);
  const [motionProfile, setMotionProfile] = useState<CoinGesture>(0.5);
  const [pickerOpen, setPickerOpen] = useState(false);
  const finishMotion = useCallback(
    () => setPhase((p) => (p === 'animating' ? 'result' : p)),
    [],
  );
  const busy = useRef(false);
  const panel = useRef<HTMLDivElement>(null);
  const resultPanel = useRef<HTMLDivElement>(null);
  const flipButton = useRef<HTMLButtonElement>(null);
  const reviewButton = useRef<HTMLButtonElement>(null);
  const { refreshBalance } = useTopUp();
  const storageKey = coinFlipPendingKey(customerId);
  const items = vault.ok ? vault.items.filter((item) => !item.locked) : [];
  const selectedCard = items.find((item) => item.pullId === selected);
  const config = settings.ok ? settings.settings : null;
  const live = round ? quoteIsLive(round, now) : false;
  const locked = !['idle', 'result'].includes(phase);

  useModalA11y(panel, phase === 'confirm', () => setPhase('idle'));

  function clearPending(id: string, removeUrl = false) {
    try {
      if (localStorage.getItem(storageKey) === id)
        localStorage.removeItem(storageKey);
    } catch {
      /* URL still identifies the receipt. */
    }
    setPendingId(null);
    if (removeUrl) {
      const url = new URL(window.location.href);
      if (url.searchParams.get('round') === id) {
        url.searchParams.delete('round');
        window.history.replaceState(window.history.state, '', url);
      }
    }
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
      const url = new URL(window.location.href);
      url.searchParams.set('round', id);
      window.history.replaceState(window.history.state, '', url);
      saved = true;
    } catch {
      /* Local storage remains a recovery path. */
    }
    if (!saved) throw new Error('Cannot retain the round for recovery.');
    setPendingId(id);
  }
  function settled(receipt: CoinFlipRound, animate = false) {
    setRound(receipt);
    clearPending(receipt.id);
    setError('');
    setPhase(animate ? 'animating' : 'result');
    setHistoryRevision((value) => value + 1);
    void refreshBalance().catch(() => {});
    void getVault()
      .then(setVault)
      .catch(() => {});
    void getCoinFlipSettings()
      .then(setSettings)
      .catch(() => {});
  }
  async function recover(id: string) {
    if (busy.current) return;
    busy.current = true;
    setPendingId(id);
    setPhase('recovering');
    try {
      const response = await getCoinFlipRound(id);
      if (response.ok) {
        setRound(response.round);
        if (response.round.status !== 'quoted') settled(response.round);
        else
          setError(
            'This flip has no confirmed result yet. Retry the same flip to resolve it.',
          );
      } else {
        if (response.missing) {
          clearPending(id, true);
          setRound(null);
          setPhase('idle');
        }
        setError(response.error);
      }
    } catch {
      setError(
        'Connection interrupted. Your result is unknown. Check this flip again.',
      );
    } finally {
      busy.current = false;
    }
  }
  useEffect(() => {
    let id = initialRoundId;
    try {
      id = localStorage.getItem(storageKey) || id;
    } catch {
      /* Use the receipt URL. */
    }
    let active = true;
    void Promise.resolve().then(() => {
      if (!active) return;
      if (id) void recover(id);
      else setPhase('idle');
    });
    return () => {
      active = false;
    };
    // Recovery is bound to this authenticated page mount, never to changing UI state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerId, initialRoundId]);
  useEffect(() => {
    if (phase !== 'armed' && phase !== 'confirm') return;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [phase]);
  useEffect(() => {
    if (phase === 'result') resultPanel.current?.focus();
  }, [phase, round?.id]);
  useEffect(() => {
    if (phase === 'armed') flipButton.current?.focus();
    if (phase === 'idle' && round) reviewButton.current?.focus();
  }, [phase, round]);
  useEffect(() => {
    if (!pickerOpen && selected && document.activeElement === document.body)
      reviewButton.current?.focus({ preventScroll: true });
  }, [pickerOpen, selected]);

  async function review() {
    if (busy.current || locked || !selectedCard || !config?.eligible) return;
    busy.current = true;
    setPhase('quoting');
    setError('');
    try {
      const response = await quoteCoinFlip(selectedCard.pullId);
      if (response.ok) {
        setRound(response.round);
        setNow(Date.now());
        setPhase('confirm');
      } else {
        setError(response.error);
        setPhase('idle');
      }
    } catch {
      setError('Could not load a quote. Your card has not been committed.');
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
        (phase !== 'armed' || !round || !quoteIsLive(round, Date.now())))
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
    try {
      const response = await acceptCoinFlip(id);
      if (response.ok && response.round.status !== 'quoted')
        settled(response.round, !retry);
      else if (!response.ok && !response.uncertain) {
        clearPending(id, true);
        setRound(null);
        setPhase('idle');
        setError(response.error);
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
  const card =
    round && !['idle', 'quoting', 'loading'].includes(phase)
      ? round.card
      : selectedCard
        ? {
            name: selectedCard.card.name,
            image: selectedCard.card.slabImage || selectedCard.card.image,
          }
        : null;
  const value =
    round && !['idle', 'quoting', 'loading'].includes(phase)
      ? round.stake_amount
      : selectedCard?.card.priceMyr;
  const published =
    round && !['idle', 'quoting', 'loading'].includes(phase)
      ? round.published_win_percent
      : config?.published_win_percent;
  function chooseAnother() {
    setPhase('idle');
    setRound(null);
    setSelected('');
    setError('');
    setPickerOpen(true);
  }

  return (
    <>
      <Link
        href="/vault"
        className="inline-flex min-h-11 items-center gap-2 text-sm text-neutral-400 hover:text-white"
      >
        <ArrowLeft size={16} aria-hidden /> Vault
      </Link>
      <div className="mt-2 mb-6 flex items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-black tracking-tight">
            One card. One flip.
          </h1>
          <p className="mt-2 max-w-lg text-sm text-neutral-400">
            Put a card on the table. Win its value and keep it.
          </p>
        </div>
      </div>
      <div
        className={`overflow-hidden rounded-2xl border border-white/10 bg-neutral-900 ${receiptVisible ? (outcome === 'won' ? styles.won : styles.lost) : ''}`}
      >
        <div className="grid sm:grid-cols-[minmax(0,1fr)_220px] lg:grid-cols-[minmax(0,1fr)_260px]">
          <div className={`relative flex min-w-0 flex-col ${styles.stage}`}>
            <div className="relative z-10 flex items-center justify-between gap-3 px-5 py-4 text-xs text-neutral-400">
              <span>
                Black titanium{' '}
                <span className="ml-1 text-neutral-500">/ Coin B</span>
              </span>
              <span>
                Published odds{' '}
                <strong className="ml-1 text-sm text-white">
                  {published ?? '—'}%
                </strong>
              </span>
            </div>
            <CoinStage
              armed={phase === 'armed' && live}
              outcome={outcome}
              playbackId={phase === 'animating' ? (round?.id ?? null) : null}
              profile={motionProfile}
              onFlick={(profile) => void flip(false, profile)}
              onComplete={finishMotion}
            />
            {receiptVisible && (
              <div
                key={round.id}
                aria-hidden
                className={
                  outcome === 'won' ? styles.winPulse : styles.lossPulse
                }
              />
            )}
            <div className="relative z-10 mt-auto flex min-h-16 items-center justify-between gap-3 px-5 pb-5 text-xs text-neutral-400">
              {phase === 'animating' ? (
                <>
                  <span role="status">Coin in flight…</span>
                  <button
                    className="min-h-11 font-semibold text-white underline underline-offset-4"
                    onClick={finishMotion}
                  >
                    Skip animation
                  </button>
                </>
              ) : (
                <>
                  <span className="flex items-center gap-2">
                    <ArrowUp size={16} aria-hidden />
                    {phase === 'armed' && live
                      ? 'Hold the coin, drag up, release to toss.'
                      : phase === 'idle'
                        ? selectedCard
                          ? 'Review and confirm your card to enable dragging.'
                          : 'Choose a card to get started.'
                        : 'Emblem wins · Wordmark loses'}
                  </span>
                  <span className="hidden shrink-0 lg:block">
                    Mouse or touch
                  </span>
                </>
              )}
            </div>
          </div>
          <section
            aria-label="Selected card"
            className="flex min-w-0 flex-col border-t border-white/10 p-5 sm:border-t-0 sm:border-l lg:p-6"
          >
            <div className="flex min-h-8 items-center justify-between gap-2">
              <h2 className="text-sm font-semibold">Your card</h2>
              {card && phase === 'idle' && (
                <button
                  onClick={() => setPickerOpen(true)}
                  className="min-h-9 text-xs text-neutral-300 underline underline-offset-4 hover:text-white"
                >
                  Change card
                </button>
              )}
            </div>
            {card ? (
              <div className="mt-3 flex items-center gap-4 sm:flex-col sm:items-stretch sm:gap-0">
                <div
                  key={`${card.name}:${receiptVisible ? round.id : 'selected'}`}
                  className={`relative w-20 shrink-0 overflow-hidden sm:mx-auto sm:w-full sm:max-w-44 ${styles.cardArt}`}
                >
                  <div className="relative aspect-[3/4]">
                    <Image
                      src={card.image || '/images/app/polycards-card-back.webp'}
                      alt={card.name}
                      fill
                      sizes="(max-width:640px) 80px, 180px"
                      unoptimized
                      className="object-contain"
                    />
                    <span aria-hidden className={styles.sweep} />
                  </div>
                </div>
                <div className="min-w-0 sm:mt-4">
                  <p className="text-sm font-semibold leading-snug">
                    {card.name}
                  </p>
                  <p className="mt-1 text-xs text-neutral-400">
                    {phase === 'result'
                      ? outcome === 'won'
                        ? 'Kept in your Vault'
                        : 'Removed from your Vault'
                      : round && locked
                        ? 'Confirmed card value'
                        : 'Market value'}
                  </p>
                  <p className="mt-1 font-display text-2xl font-black tabular-nums">
                    {value == null ? 'Quote on review' : rm(value)}
                  </p>
                </div>
              </div>
            ) : (
              <button
                disabled={locked || !items.length}
                onClick={() => setPickerOpen(true)}
                className="mt-3 flex min-h-32 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-white/25 px-4 py-5 text-sm text-neutral-300 transition-colors hover:border-white/60 hover:bg-white/5 focus-visible:outline-2 focus-visible:outline-white disabled:opacity-50 sm:min-h-64"
              >
                <Layers3 size={28} strokeWidth={1.3} aria-hidden />
                <span>Choose from Vault</span>
                <span className="text-xs text-neutral-400">
                  {items.length} available{' '}
                  {items.length === 1 ? 'card' : 'cards'}
                </span>
              </button>
            )}
            <div className="mt-5 border-t border-white/10 pt-5">
              {receiptVisible ? (
                <div
                  ref={resultPanel}
                  tabIndex={-1}
                  role="status"
                  className={`outline-none ${styles.receipt}`}
                >
                  <p className="flex items-center gap-2 text-xs text-neutral-400">
                    {outcome === 'won' && <Check size={14} aria-hidden />}
                    {outcome === 'won'
                      ? 'Emblem · You won'
                      : 'Wordmark · Flip lost'}
                  </p>
                  <h2
                    className={`mt-2 font-display text-3xl font-black tabular-nums ${outcome === 'won' ? 'text-buyback-fg' : 'text-white'}`}
                  >
                    {outcome === 'won'
                      ? `+${rm(round.win_amount)}`
                      : 'Card forfeited'}
                  </h2>
                  <p className="mt-2 text-xs leading-relaxed text-neutral-300">
                    {outcome === 'won'
                      ? 'Added to your withdrawable Credit. Your card stays in your Vault.'
                      : 'This card has left your Vault. No Credit was added.'}
                  </p>
                  <Pill className="mt-5 w-full" onClick={chooseAnother}>
                    Choose a card
                  </Pill>
                  <Link
                    href="/transactions"
                    className="mt-2 flex min-h-11 items-center justify-center gap-2 text-xs text-neutral-300 hover:text-white"
                  >
                    View wallet <ArrowUpRight size={14} aria-hidden />
                  </Link>
                </div>
              ) : phase === 'recovering' ? (
                <div aria-live="polite">
                  <h2 className="text-lg font-bold">
                    Resolve your previous flip
                  </h2>
                  <p className="mt-2 text-xs leading-relaxed text-neutral-300">
                    No new card can be committed while this result is uncertain.
                  </p>
                  <Pill
                    className="mt-4 w-full"
                    onClick={() => pendingId && void recover(pendingId)}
                  >
                    Check result
                  </Pill>
                  {round?.status === 'quoted' && (
                    <Pill
                      variant="secondary"
                      className="mt-2 w-full"
                      onClick={() => void flip(true)}
                    >
                      Retry same flip
                    </Pill>
                  )}
                </div>
              ) : phase === 'armed' ? (
                <div aria-live="polite">
                  <p className="text-sm font-semibold">
                    {live ? 'Your card is ready.' : 'Quote expired'}
                  </p>
                  <p className="mt-2 text-xs leading-relaxed text-neutral-400">
                    {live
                      ? 'Mouse: click and hold the coin, drag upward, then release. Touch: flick upward. Releasing commits your card.'
                      : 'Review again for a fresh value and odds.'}
                  </p>
                  <Pill
                    ref={flipButton}
                    className="mt-4 w-full"
                    disabled={!live}
                    onClick={() => void flip()}
                  >
                    Flip coin
                  </Pill>
                  <Pill
                    variant="secondary"
                    className="mt-2 w-full"
                    onClick={() => setPhase('idle')}
                  >
                    {live ? 'Cancel' : 'Review again'}
                  </Pill>
                </div>
              ) : ['submitting', 'loading', 'animating'].includes(phase) ? (
                <p role="status" className="py-3 text-sm text-neutral-300">
                  {phase === 'loading'
                    ? 'Checking previous flips…'
                    : phase === 'animating'
                      ? 'Watch the landing.'
                      : 'Confirming your flip…'}
                </p>
              ) : (
                <>
                  <dl className="space-y-3 text-xs">
                    <div className="flex justify-between gap-3">
                      <dt className="text-neutral-400">If you win</dt>
                      <dd className="text-right text-buyback-fg">
                        Keep card
                        {value != null ? ` + ${rm(value)}` : ' + its value'}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt className="text-neutral-400">If you lose</dt>
                      <dd>Card forfeited</dd>
                    </div>
                  </dl>
                  <Pill
                    ref={reviewButton}
                    className="mt-5 w-full"
                    disabled={!selectedCard || !config?.eligible || locked}
                    onClick={() => void review()}
                  >
                    {phase === 'quoting'
                      ? 'Getting quote…'
                      : 'Review card & odds'}
                  </Pill>
                  {!items.length && (
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
                  className="mt-4 text-xs leading-relaxed text-red-300"
                >
                  {error}
                </p>
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
          One card per flip. A win pays 100% of its confirmed value as
          withdrawable Credit and keeps your card. A loss permanently forfeits
          it. Bonus and gift-funded cards are included. Standard account and
          withdrawal checks still apply.
          {config?.max_stake_amount != null
            ? ` Maximum card value ${rm(config.max_stake_amount)}.`
            : ''}{' '}
          Mouse drag distance and flick speed change the motion, not the odds.
        </p>
      </details>
      <CoinFlipHistory refresh={historyRevision} />
      {pickerOpen && phase === 'idle' && (
        <VaultCardPicker
          items={items}
          selected={selected}
          maximum={config?.max_stake_amount ?? null}
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
              className="relative max-h-[90dvh] w-full overflow-y-auto rounded-t-2xl border border-white/15 bg-neutral-950 p-6 pb-8 outline-none sm:max-w-md sm:rounded-2xl"
            >
              <h2
                id="flip-confirm-title"
                className="font-display text-2xl font-bold"
              >
                Put this card on the line?
              </h2>
              <div className="mt-5 flex items-center gap-4">
                <Image
                  src={
                    round.card.image || '/images/app/polycards-card-back.webp'
                  }
                  alt=""
                  width={64}
                  height={88}
                  unoptimized
                  className="h-24 w-16 object-contain"
                />
                <div>
                  <p className="text-sm font-semibold">{round.card.name}</p>
                  <p className="mt-1 font-display text-3xl font-black">
                    {rm(round.stake_amount)}
                  </p>
                </div>
              </div>
              <dl className="mt-5 space-y-4 text-sm">
                <div>
                  <dt className="text-neutral-400">Win · Emblem</dt>
                  <dd className="mt-1">
                    Keep your card +{' '}
                    <strong className="text-buyback-fg">
                      {rm(round.stake_amount)} withdrawable Credit
                    </strong>
                  </dd>
                </div>
                <div>
                  <dt className="text-neutral-400">Lose · Wordmark</dt>
                  <dd className="mt-1 text-red-300">
                    Your card is permanently forfeited. No Credit.
                  </dd>
                </div>
                <div className="flex justify-between border-t border-white/10 pt-4">
                  <dt className="text-neutral-400">Published win odds</dt>
                  <dd>{round.published_win_percent}%</dd>
                </div>
              </dl>
              <p className="mt-4 text-xs text-neutral-400">
                {live
                  ? 'Quote valid for 60 seconds from issue. The flip commits when you flick or tap Flip coin.'
                  : 'This quote expired. Close and review your card again.'}
              </p>
              <div className="mt-6 flex gap-3">
                <Pill
                  variant="secondary"
                  className="flex-1"
                  onClick={() => setPhase('idle')}
                >
                  Cancel
                </Pill>
                <Pill
                  className="flex-1"
                  disabled={!live}
                  onClick={() => setPhase('armed')}
                >
                  Confirm card
                </Pill>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

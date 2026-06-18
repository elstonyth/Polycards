// src/components/SellBackPanel.tsx
'use client';

// Shared instant/flat sell-back for a single pull. Lifted verbatim in behavior
// from the classic reveal (PackOpenOverlay.tsx:118-190,676-762): reveal ping →
// server deadline → wall-clock countdown → confirm modal → sell. The reveal ping
// fires when `active` flips true (the slot passes active only after the reel
// settles, so the 30s window isn't eaten by the spin — PRD §5.2).
import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { SELL_COUNTDOWN_SECS, sellSecondsLeft } from '@/lib/sell-countdown';
import SellConfirmModal from '@/components/SellConfirmModal';

export type SellBackOffer = {
  pullId: string;
  fmv: number;
  cardName: string;
  image: string;
  percent: number;
  amount: number;
  vaultPercent: number;
  vaultAmount: number;
  /** Fallback instant deadline (epoch ms) if the reveal ping fails. */
  instantDeadlineMs: number;
};

export type SellBackFn = (
  pullId: string,
) => Promise<
  | { ok: true; amount: number; percent: number; balance: number }
  | { ok: false; error: string; needsAuth?: boolean }
>;

export type RevealFn = (
  pullId: string,
) => Promise<{ ok: true; instantDeadlineMs: number } | { ok: false }>;

const money = (n: number) =>
  n.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

export function SellBackPanel({
  offer,
  active,
  reduced,
  onSellBack,
  onReveal,
  onSold,
}: {
  /** Null = no sell-back for this pull (e.g. pullId missing). */
  offer: SellBackOffer | null;
  /** Reel has settled — safe to start the reveal ping + countdown. */
  active: boolean;
  reduced: boolean;
  onSellBack: SellBackFn;
  onReveal?: RevealFn;
  /** Notify the controller of the post-sell balance (so CREDIT refreshes). */
  onSold?: (balance: number) => void;
}) {
  const [sell, setSell] = useState<
    | { phase: 'idle' }
    | { phase: 'selling' }
    | { phase: 'sold'; amount: number; balance: number }
    | { phase: 'error'; message: string }
  >({ phase: 'idle' });
  const [deadlineMs, setDeadlineMs] = useState<number | null>(
    offer ? offer.instantDeadlineMs : null,
  );
  const [secondsLeft, setSecondsLeft] = useState(SELL_COUNTDOWN_SECS);
  const sellExpired = secondsLeft <= 0;
  const revealPinged = useRef(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  // Reveal ping ONCE, when the reel has settled (active) — anchors the 30s window.
  useEffect(() => {
    if (!active || !offer || revealPinged.current) return;
    revealPinged.current = true;
    if (!onReveal) return;
    let cancelled = false;
    onReveal(offer.pullId).then((r) => {
      if (!cancelled && r.ok) setDeadlineMs(r.instantDeadlineMs);
    });
    return () => {
      cancelled = true;
    };
  }, [active, offer, onReveal]);

  // Tick the visible countdown to the server deadline (wall-clock).
  useEffect(() => {
    if (!active || !offer || deadlineMs === null || sell.phase === 'sold') return;
    const tick = () => setSecondsLeft(sellSecondsLeft(deadlineMs, Date.now()));
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [active, offer, deadlineMs, sell.phase]);

  async function handleSellBack() {
    if (!offer || sell.phase === 'selling' || sell.phase === 'sold') return;
    setSell({ phase: 'selling' });
    try {
      const res = await onSellBack(offer.pullId);
      if (res.ok) {
        setSell({ phase: 'sold', amount: res.amount, balance: res.balance });
        setConfirmOpen(false);
        onSold?.(res.balance);
      } else {
        setSell({ phase: 'error', message: res.error });
        setConfirmOpen(false);
      }
    } catch {
      setSell({
        phase: 'error',
        message: 'Something went wrong. Please try again.',
      });
      setConfirmOpen(false);
    }
  }

  if (!offer) return null;

  const barPct = sellExpired ? 0 : Math.max(0, (secondsLeft / SELL_COUNTDOWN_SECS) * 100);

  return (
    <div className="flex w-full max-w-[340px] flex-col items-center gap-2">
      {sell.phase === 'sold' ? (
        <p className="flex h-12 w-full items-center justify-center rounded-xl border border-emerald-400/50 bg-emerald-400/10 text-sm font-bold text-emerald-300">
          +${money(sell.amount)} credited · balance ${money(sell.balance)}
        </p>
      ) : (
        <>
          <button
            type="button"
            onClick={() => setConfirmOpen(true)}
            disabled={sell.phase === 'selling'}
            className="inline-flex h-12 w-full items-center justify-center rounded-xl border border-amber-400/60 bg-amber-400/10 text-sm font-bold text-amber-300 transition-colors hover:bg-amber-400/20 disabled:opacity-60"
          >
            {sell.phase === 'selling'
              ? 'Selling…'
              : sellExpired
                ? `Sell for $${money(offer.vaultAmount)} (${offer.vaultPercent}%)`
                : `Sell back for $${money(offer.amount)} (${offer.percent}%) · ${secondsLeft}s`}
          </button>
          {/* Draining bar — decorative; the countdown text is the SR source. */}
          {!sellExpired && (
            <div
              aria-hidden
              className="h-1 w-full overflow-hidden rounded-full bg-white/10"
            >
              <div
                className="h-full rounded-full bg-gradient-to-r from-fuchsia-500 to-violet-500"
                style={{
                  width: `${barPct}%`,
                  transition: reduced ? undefined : 'width 250ms linear',
                }}
              />
            </div>
          )}
          <p className="text-center text-[11px] text-white/45">
            {sellExpired
              ? `Instant offer expired — this card is in your vault and sells at the flat ${offer.vaultPercent}% rate.`
              : `Or keep it: vaulted cards sell anytime at the flat ${offer.vaultPercent}% rate.`}
          </p>
        </>
      )}
      {sell.phase === 'error' && (
        <p className="text-center text-[12px] font-medium text-red-400">
          {sell.message}
        </p>
      )}
      <SellConfirmModal
        open={confirmOpen}
        cardName={offer.cardName}
        image={offer.image}
        fmv={offer.fmv}
        rateType={sellExpired ? 'flat' : 'instant'}
        percent={sellExpired ? offer.vaultPercent : offer.percent}
        netCredit={sellExpired ? offer.vaultAmount : offer.amount}
        secondsLeft={sellExpired ? undefined : secondsLeft}
        busy={sell.phase === 'selling'}
        onConfirm={handleSellBack}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
}
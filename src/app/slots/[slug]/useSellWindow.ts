'use client';

// One shared 30s sell window for the whole pull (spec features 9-10). Behavior
// lifted from the since-deleted SellBackPanel (reveal ping once when active →
// server deadline → wall-clock countdown) but SHARED: one deadline (earliest
// across pulls), one countdown, per-card sell states, and a 'vaulted' terminal
// state at expiry. The SellBackOffer/SellBackFn/RevealFn types moved here when
// that component was removed (PR #129 review — it was dead code that absorbed
// the P1-1 firmness fix).
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  SELL_COUNTDOWN_SECS,
  sellSecondsLeft,
  sharedDeadlineMs,
} from '@/lib/sell-countdown';
// Every per-card state transition below is pure and lives in reveal-phase.ts,
// where it is unit-tested. What stays here is the React shell: the batch reset,
// the reveal ping, the wall clock, and the server round-trip.
import {
  allConcluded as allStatesConcluded,
  beginSellAt,
  expirySweep,
  keepAt,
  resolvedStates,
  type SellState,
} from '@/lib/reveal-phase';
export type SellBackOffer = {
  pullId: string;
  fmv: number;
  cardName: string;
  image: string;
  slabImage: string | null;
  percent: number;
  amount: number;
  vaultPercent: number;
  vaultAmount: number;
  /** Fallback instant deadline (epoch ms) if the reveal ping fails. */
  instantDeadlineMs: number;
  /** false = the quote was priced on the backend's FX display fallback and
   *  selling would be refused ("Exchange rate unavailable") — render the
   *  unavailable state instead of a firm offer (sim finding P1-1). */
  firm: boolean;
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

export function useSellWindow({
  offers,
  active,
  onReveal,
  onSellBack,
  onSold,
}: {
  offers: (SellBackOffer | null)[];
  active: boolean;
  onReveal?: RevealFn;
  onSellBack: SellBackFn;
  onSold?: (balance: number, amount: number) => void;
}) {
  const [states, setStates] = useState<SellState[]>(() =>
    offers.map(() => ({ phase: 'idle' })),
  );
  const [deadlineMs, setDeadlineMs] = useState<number | null>(() =>
    sharedDeadlineMs(offers.map((o) => o?.instantDeadlineMs)),
  );
  const [secondsLeft, setSecondsLeft] = useState(SELL_COUNTDOWN_SECS);
  const pinged = useRef(false);

  // Reset per new batch (keyed by the first pullId).
  const batchKey = offers.find((o) => o !== null)?.pullId ?? null;
  useEffect(() => {
    pinged.current = false;
    setStates(offers.map(() => ({ phase: 'idle' })));
    setDeadlineMs(sharedDeadlineMs(offers.map((o) => o?.instantDeadlineMs)));
    setSecondsLeft(SELL_COUNTDOWN_SECS);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on batch identity only, by design (same pattern as SellBackPanel)
  }, [batchKey]);

  // Reveal ping ONCE per batch when the card backs appear — anchors the window.
  useEffect(() => {
    if (!active || pinged.current) return;
    pinged.current = true;
    if (!onReveal) return;
    let cancelled = false;
    void Promise.all(
      offers.map((o) => (o ? onReveal(o.pullId) : Promise.resolve(null))),
    )
      .then((results) => {
        if (cancelled) return;
        const fresh = results.map((r, i) =>
          r && r.ok ? r.instantDeadlineMs : offers[i]?.instantDeadlineMs,
        );
        const next = sharedDeadlineMs(fresh);
        if (next !== null) setDeadlineMs(next);
      })
      .catch(() => {
        /* keep the open-response fallback deadline (same as SellBackPanel) */
      });
    return () => {
      cancelled = true;
    };
  }, [active, offers, onReveal]);

  // Wall-clock tick.
  useEffect(() => {
    if (!active || deadlineMs === null) return;
    const tick = () => setSecondsLeft(sellSecondsLeft(deadlineMs, Date.now()));
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [active, deadlineMs]);

  const expired = active && secondsLeft <= 0;

  // What CONSUMERS see. The effect below cannot run in the render where
  // `expired` flips (it is keyed on it), so the raw states are one beat stale
  // exactly when the clock reads out. Sweeping here as well makes the pair
  // atomic: a card mid-sale keeps saying "Selling…" across the deadline instead
  // of flashing "Stored in your vault", and nothing else can show a live Sell
  // button on a closed window. The effect still runs — it is what the sell/keep
  // re-entry guards read (they see `prev`, not this).
  const resolved = resolvedStates(states, expired);

  // Expiry: every unsold card becomes 'vaulted' (server enforces the same).
  useEffect(() => {
    if (!expired) return;
    // Wrapped, not point-free: React hands an updater exactly one argument, so
    // a second parameter added to expirySweep later would silently bind to
    // React's own value instead of failing to compile.
    setStates((prev) => expirySweep(prev));
  }, [expired]);

  // "Keep in vault" (spec decision #26): conclude this card immediately without
  // any server call — the pull is ALREADY vaulted server-side, so keeping is a
  // pure client-side state flip to 'vaulted'. Mirrors the sell guard: a no-op
  // once the card is selling/sold/vaulted.
  const keep = useCallback((index: number) => {
    setStates((prev) => keepAt(prev, index));
  }, []);

  // Returns true only on a successful server sell — lets the caller chirp
  // 'credit' on success and stay silent on a guard-block or error.
  const sell = useCallback(
    async (index: number): Promise<boolean> => {
      const offer = offers[index];
      if (!offer) return false;
      // Non-firm quote (FX display fallback): the server would refuse the
      // sell with "Exchange rate unavailable" — never fire it. The reveal UI
      // hides the Sell CTA too; this guard is defense in depth.
      if (!offer.firm) return false;
      // Block re-entry while selling/sold AND once vaulted — a confirm modal
      // left open across expiry must not fire a sell (server enforces the
      // deadline too; this is client honesty). beginSellAt returns `prev`
      // BY IDENTITY when it refuses, which is how the block is read back out
      // of the updater — the guard has to run against the freshest states, so
      // it cannot be hoisted above setStates.
      let blocked = false;
      setStates((prev) => {
        const next = beginSellAt(prev, index);
        blocked = next === prev;
        return next;
      });
      if (blocked) return false;
      try {
        const res = await onSellBack(offer.pullId);
        setStates((prev) => {
          const next = [...prev];
          next[index] = res.ok
            ? { phase: 'sold', amount: res.amount }
            : { phase: 'error', message: res.error };
          return next;
        });
        // `amount` is passed alongside the balance so the caller can confirm
        // the sale OUTSIDE this stage. The in-card "+RM x credited" footer is
        // torn down with the reveal (auto-conclude, or expiry mid-flight), and
        // a player who never saw it has no on-screen proof the money landed.
        if (res.ok) onSold?.(res.balance, res.amount);
        return res.ok;
      } catch {
        setStates((prev) => {
          const next = [...prev];
          next[index] = {
            phase: 'error',
            message: 'Something went wrong. Please try again.',
          };
          return next;
        });
        return false;
      }
    },
    [offers, onSellBack, onSold],
  );

  // Every card is terminal (sold | vaulted) — drives the reveal auto-conclude
  // (spec decision #27). Only real offers count; a null offer (no pull) is
  // treated as already-concluded so it never blocks the conclusion.
  const allConcluded = allStatesConcluded(
    resolved,
    offers.map((o) => o !== null),
  );

  return {
    deadlineMs,
    secondsLeft,
    expired,
    states: resolved,
    sell,
    keep,
    allConcluded,
  };
}

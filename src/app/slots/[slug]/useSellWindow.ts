'use client';

// One shared 30s sell window for the whole pull (spec features 9-10). Behavior
// lifted from SellBackPanel (reveal ping once when active → server deadline →
// wall-clock countdown) but SHARED: one deadline (earliest across pulls), one
// countdown, per-card sell states, and a 'vaulted' terminal state at expiry.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  SELL_COUNTDOWN_SECS,
  sellSecondsLeft,
  sharedDeadlineMs,
} from '@/lib/sell-countdown';
import type {
  SellBackOffer,
  SellBackFn,
  RevealFn,
} from '@/components/SellBackPanel';

export type SellState =
  | { phase: 'idle' }
  | { phase: 'selling' }
  | { phase: 'sold'; amount: number }
  | { phase: 'error'; message: string }
  | { phase: 'vaulted' };

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
  onSold?: (balance: number) => void;
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

  // Expiry: every unsold card becomes 'vaulted' (server enforces the same).
  useEffect(() => {
    if (!expired) return;
    setStates((prev) =>
      prev.map((s) =>
        s.phase === 'sold' || s.phase === 'selling' ? s : { phase: 'vaulted' },
      ),
    );
  }, [expired]);

  // "Keep in vault" (spec decision #26): conclude this card immediately without
  // any server call — the pull is ALREADY vaulted server-side, so keeping is a
  // pure client-side state flip to 'vaulted'. Mirrors the sell guard: a no-op
  // once the card is selling/sold/vaulted.
  const keep = useCallback((index: number) => {
    setStates((prev) => {
      const cur = prev[index];
      if (
        !cur ||
        cur.phase === 'selling' ||
        cur.phase === 'sold' ||
        cur.phase === 'vaulted'
      ) {
        return prev;
      }
      const next = [...prev];
      next[index] = { phase: 'vaulted' };
      return next;
    });
  }, []);

  // Returns true only on a successful server sell — lets the caller chirp
  // 'credit' on success and stay silent on a guard-block or error.
  const sell = useCallback(
    async (index: number): Promise<boolean> => {
      const offer = offers[index];
      if (!offer) return false;
      let blocked = false;
      setStates((prev) => {
        const cur = prev[index];
        // Block re-entry while selling/sold AND once vaulted — a confirm modal
        // left open across expiry must not fire a sell (server enforces the
        // deadline too; this is client honesty).
        if (
          !cur ||
          cur.phase === 'selling' ||
          cur.phase === 'sold' ||
          cur.phase === 'vaulted'
        ) {
          blocked = true;
          return prev;
        }
        const next = [...prev];
        next[index] = { phase: 'selling' };
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
        if (res.ok) onSold?.(res.balance);
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
  const allConcluded =
    states.length > 0 &&
    states.every((s, i) => {
      if (!offers[i]) return true;
      return s.phase === 'sold' || s.phase === 'vaulted';
    });

  return { deadlineMs, secondsLeft, expired, states, sell, keep, allConcluded };
}

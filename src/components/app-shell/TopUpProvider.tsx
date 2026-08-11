'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import { useRouter } from 'next/navigation';
import { getCreditBalance } from '@/lib/actions/vault';
import { openAuth } from '@/components/AuthButton';
import { useAuth } from '@/components/auth/AuthProvider';
import TopUpSheet from './TopUpSheet';

type TopUpContextValue = {
  /** RM credit balance; null while loading or logged out. */
  balance: number | null;
  /** Open the global top-up sheet (routes logged-out users to login). */
  openTopUp: () => void;
  /** Re-fetch the balance from the backend. */
  refreshBalance: () => Promise<void>;
  /** Push a known-fresh balance (e.g. returned by a purchase action). */
  applyBalance: (balance: number) => void;
};

const TopUpContext = createContext<TopUpContextValue | null>(null);

export function useTopUp(): TopUpContextValue {
  const ctx = useContext(TopUpContext);
  if (!ctx) throw new Error('useTopUp must be used within TopUpProvider');
  return ctx;
}

/**
 * Holds the header credit balance and the global top-up sheet. Balance is not
 * part of AuthProvider (it changes on every purchase/top-up), so it lives here
 * and pages can push fresh values via applyBalance.
 */
export function TopUpProvider({ children }: { children: ReactNode }) {
  const { customer } = useAuth();
  const router = useRouter();
  // The money dot used to be re-read here on every balance movement (a sell, a
  // top-up, a spin charge, a payout), so no call site had to remember to light
  // it. That went with the dot itself on 2026-08-11 — see the SUSPENDED banner
  // in components/account/credit-dot.tsx. Deliberately NOT left in place as
  // harmless plumbing: this refresh is the one path createUnreadDot exempts
  // from its 30s throttle, so keeping it would have cost a server-action round
  // trip per SPIN for a signal nothing renders — and the throttle exists
  // because of the 2026-07-07 store-read-ceiling incident. Restoring the dot
  // means restoring this line too. CreditDotProvider still wraps this one in
  // the layout; MarkCreditsSeen (/transactions) is its only live consumer now.
  // Balance is stored WITH the customer id it was fetched for. A value tagged
  // for another identity never renders (security review: on logout→login as a
  // different account, an untagged balance briefly leaked the previous user's
  // amount until the new fetch resolved).
  const [balance, setBalance] = useState<{
    forId: string;
    value: number;
  } | null>(null);
  const [open, setOpen] = useState(false);

  // Fetch on login / account switch. setState only ever runs in promise
  // callbacks (never synchronously in the effect); logged-out renders null
  // via derivation below instead of a state write.
  useEffect(() => {
    if (!customer) return;
    const forId = customer.id;
    let cancelled = false;
    getCreditBalance()
      .then((value) => {
        if (!cancelled) setBalance(value == null ? null : { forId, value });
      })
      .catch(() => {
        // Header chip degrades to "—"; pages surface their own errors.
        if (!cancelled) setBalance(null);
      });
    return () => {
      cancelled = true;
    };
  }, [customer]);

  // Event-handler refresh (post-purchase, focus, etc.) — not effect-driven.
  const refreshBalance = useCallback(async () => {
    if (!customer) return;
    const forId = customer.id;
    try {
      const value = await getCreditBalance();
      setBalance(value == null ? null : { forId, value });
    } catch {
      setBalance(null);
    }
  }, [customer]);

  // Fresh values pushed by purchase/claim actions inherit the CURRENT
  // identity; ignored when somehow fired while logged out.
  const applyBalance = useCallback(
    (value: number) => {
      if (!customer) return;
      setBalance({ forId: customer.id, value });
    },
    [customer],
  );

  const openTopUp = useCallback(() => {
    if (!customer) {
      openAuth('login');
      return;
    }
    setOpen(true);
  }, [customer]);

  // Logged-out and cross-identity values derive to null — never rendered.
  const shownBalance =
    customer && balance && balance.forId === customer.id ? balance.value : null;

  return (
    <TopUpContext.Provider
      value={{
        balance: shownBalance,
        openTopUp,
        refreshBalance,
        applyBalance,
      }}
    >
      {children}
      <TopUpSheet
        open={open}
        balance={shownBalance}
        onClose={() => setOpen(false)}
        onToppedUp={(next) => {
          applyBalance(next);
          // Server-rendered balances (/me wallet card, /wallet stats) refetch.
          router.refresh();
        }}
      />
    </TopUpContext.Provider>
  );
}

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
import { getCreditBalance, getPendingDeposits } from '@/lib/actions/vault';
import { rm } from '@/lib/format';
import { openAuth } from '@/components/AuthButton';
import { useAuth } from '@/components/auth/AuthProvider';
import { SuccessToast } from '@/components/ui/SuccessToast';
import { useCreditDot } from './CreditDotProvider';
import TopUpSheet from './TopUpSheet';

/** How often to look while a gateway payment is outstanding. Their callback
 *  credits in about a second, so this is the resolution of "the balance just
 *  updates by itself" — not a race with anything. */
const DEPOSIT_POLL_MS = 10_000;

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
  // Every balance movement writes a credit_transaction, and that row is exactly
  // what the money dot watches. Refreshing HERE rather than at each call site
  // means a sell, a top-up, a spin charge and a payout all light the dot
  // without anyone remembering to wire it. CreditDotProvider sits outside this
  // one in the layout for this reason.
  const { refresh: refreshCreditDot } = useCreditDot();
  // Balance is stored WITH the customer id it was fetched for. A value tagged
  // for another identity never renders (security review: on logout→login as a
  // different account, an untagged balance briefly leaked the previous user's
  // amount until the new fetch resolved).
  const [balance, setBalance] = useState<{
    forId: string;
    value: number;
  } | null>(null);
  const [open, setOpen] = useState(false);
  // Raised when a gateway deposit lands while the customer is on the site.
  // `nonce` restarts the countdown when two top-ups credit the same amount.
  const [credited, setCredited] = useState<{
    message: string;
    nonce: number;
  } | null>(null);

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

  // The balance updating BY ITSELF after a gateway payment — what every other
  // payment app does, and what the site did not: credit landed in the ledger
  // seconds after the callback, but nothing on screen changed until the
  // customer reloaded, so a paid top-up still looked like a failed one.
  //
  // Lives in the provider, not on /transactions, because the return URL is only
  // where the customer STARTS waiting: many wander off to the packs page while
  // the payment clears, and the header chip is what they watch. Both surfaces
  // update from this one watcher (a router.refresh() re-renders whatever page
  // is mounted, which is what retires the "Confirming your payment…" row).
  //
  // It costs one request per session for customers with nothing pending: the
  // first tick finds an empty list and never schedules another. Polling only
  // continues while something is actually outstanding, at 6/min against a
  // 480/min shared read budget.
  //
  // Chained setTimeout rather than setInterval: a slow tick must not stack.
  // Every setState below runs in a promise callback, never synchronously in the
  // effect body (see the fetch effect above for why that distinction matters).
  useEffect(() => {
    if (!customer) return;
    const forId = customer.id;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Refs seen on the previous tick, and the balance as it stood while they
    // were outstanding. Locals, not state: the watcher must survive its own
    // updates, and reading them from state would either capture a stale render
    // or restart the poll (cancelling it) on every balance change.
    let outstanding: string[] = [];
    let balanceWhileWaiting: number | null = null;

    const tick = async () => {
      try {
        const pending = await getPendingDeposits();
        if (cancelled) return;
        const refs = pending.map((deposit) => deposit.reference);
        const settled = outstanding.filter((ref) => !refs.includes(ref));
        outstanding = refs;

        if (settled.length > 0) {
          // A deposit leaving the pending list is not proof of credit — it may
          // have failed or been written off — so the toast is driven by the
          // BALANCE actually moving, never by the disappearance itself.
          const next = await getCreditBalance();
          if (cancelled) return;
          if (next != null) {
            setBalance({ forId, value: next });
            refreshCreditDot();
            const gained =
              balanceWhileWaiting == null ? 0 : next - balanceWhileWaiting;
            if (gained > 0) {
              setCredited({
                message: `${rm(gained)} added to your balance`,
                nonce: Date.now(),
              });
            }
            balanceWhileWaiting = next;
          }
          // Server-rendered money (the Transactions ledger, /me, /wallet) is
          // stale the moment the credit lands.
          router.refresh();
        } else if (refs.length > 0 && balanceWhileWaiting == null) {
          // Baseline, taken while the payment is still outstanding, so the
          // delta above is the top-up and not a pack opened in the meantime.
          const current = await getCreditBalance();
          if (cancelled) return;
          balanceWhileWaiting = current;
        }

        // Nothing outstanding: stop. A deposit started later arrives with a
        // fresh mount (the cashier redirect leaves and re-enters the app).
        if (refs.length > 0) timer = setTimeout(tick, DEPOSIT_POLL_MS);
      } catch {
        // A failed poll is not worth retrying in a loop — the ledger is still
        // the source of truth and the next navigation re-reads it.
      }
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [customer, refreshCreditDot, router]);

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
      refreshCreditDot();
    },
    [customer, refreshCreditDot],
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
      {/* Rendered unconditionally (message=null while idle) — the live region
          must exist before the text lands or screen readers skip it. */}
      <SuccessToast
        message={credited?.message ?? null}
        nonce={credited?.nonce}
        onClose={() => setCredited(null)}
      />
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

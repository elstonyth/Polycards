'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
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
  const [balance, setBalance] = useState<number | null>(null);
  const [open, setOpen] = useState(false);

  const refreshBalance = useCallback(async () => {
    if (!customer) {
      // Defer past the current tick so an effect caller never sets state
      // synchronously (react-hooks cascading-render lint).
      await Promise.resolve();
      setBalance(null);
      return;
    }
    try {
      const value = await getCreditBalance();
      setBalance(value);
    } catch {
      // Header chip degrades to "—"; pages surface their own errors.
      setBalance(null);
    }
  }, [customer]);

  useEffect(() => {
    void refreshBalance();
  }, [refreshBalance]);

  const openTopUp = useCallback(() => {
    if (!customer) {
      openAuth('login');
      return;
    }
    setOpen(true);
  }, [customer]);

  return (
    <TopUpContext.Provider
      value={{ balance, openTopUp, refreshBalance, applyBalance: setBalance }}
    >
      {children}
      <TopUpSheet
        open={open}
        balance={balance}
        onClose={() => setOpen(false)}
        onToppedUp={(next) => setBalance(next)}
      />
    </TopUpContext.Provider>
  );
}

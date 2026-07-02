'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import type { AuthCustomer } from '@/lib/actions/auth';

type AuthContextValue = {
  customer: AuthCustomer | null;
  isLoading: boolean;
  /** Update state directly (login/signup actions return the customer — no refetch). */
  setCustomer: (customer: AuthCustomer | null) => void;
  /** Re-read `/api/me` (e.g. after an out-of-band change). */
  refresh: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [customer, setCustomer] = useState<AuthCustomer | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/me', { cache: 'no-store' });
      if (!res.ok) {
        // `/api/me` returns 200 + { customer: null } for a genuine logout (the
        // happy path below handles that). A non-ok status is a transient server
        // error, NOT a logout — keep whatever session we had rather than
        // flashing logged-out. (401 is handled defensively in case the route
        // ever gains an auth guard.)
        if (res.status === 401) setCustomer(null);
        return;
      }
      const data = (await res.json()) as { customer: AuthCustomer | null };
      setCustomer(data.customer);
    } catch {
      // Network/transient failure reaching our own /api/me — preserve prior
      // state, do NOT force a logout. First-load `isLoading` still clears below.
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Hydrate an existing session on mount. The httpOnly cookie means the header
  // shows logged-out until this resolves (a brief, unavoidable first-load flash).
  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <AuthContext.Provider value={{ customer, isLoading, setCustomer, refresh }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within <AuthProvider>');
  return ctx;
}

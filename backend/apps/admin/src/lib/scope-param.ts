import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { CustomerScope } from './admin-rest';

/** `?scope=` → scope. Only an explicit `all` widens to everyone; anything
 *  else (absent, blank, a typo) is real customers. */
export const scopeFromParam = (v: string | null): CustomerScope =>
  v === 'all' ? 'all' : 'default';

/**
 * The Profit report's and Dashboard's real-customer switch, kept in the URL
 * (`?scope=all`) so a shared link opens on the same numbers. Real customers
 * is the default and leaves the URL clean.
 */
export function useScopeParam(): [CustomerScope, (s: CustomerScope) => void] {
  const [params, setParams] = useSearchParams();
  const scope = scopeFromParam(params.get('scope'));
  const setScope = useCallback(
    (next: CustomerScope) =>
      setParams(
        (prev) => {
          const out = new URLSearchParams(prev);
          if (next === 'all') out.set('scope', 'all');
          else out.delete('scope');
          return out;
        },
        { replace: true },
      ),
    [setParams],
  );
  return [scope, setScope];
}

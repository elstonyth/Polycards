/**
 * Show the brand loader once per browser session: the first call in a tab session
 * returns true and records it; later calls return false. Storage that is missing or
 * throws (private mode, blocked site data) means "show", which costs at most one
 * extra loader and never breaks the page.
 */

export const BRAND_LOADER_SESSION_KEY = 'polycards:brand-loader-seen';

type SessionLike = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStorage(): SessionLike | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function claimFirstVisitThisSession(
  storage: SessionLike | null = defaultStorage(),
): boolean {
  if (!storage) return true;
  try {
    if (storage.getItem(BRAND_LOADER_SESSION_KEY) === '1') return false;
    storage.setItem(BRAND_LOADER_SESSION_KEY, '1');
    return true;
  } catch {
    return true;
  }
}

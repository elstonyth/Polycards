// An expired admin login answers 401 to every /admin/* call. Mercur's own API
// helper sends the browser to its login page when that happens; our direct
// fetches (admin-rest, automation, assistant) did not, so staff kept a page
// that looked fine while every save and upload showed "Unauthorized" (Anson's
// delivery photos, 2026-10-30). Imported first in main.tsx, this wraps
// window.fetch once so every caller gets Mercur's behaviour.
//
// 401 only: a missing permission is a 403 and must stay on the page. The one
// 403 that moves is a login with no authenticator yet (two-step sign-in,
// 2026-11-07), which goes to its setup; and Mercur's own login page, which has
// no code step, is never shown: every visit to it goes to ours (lib/two-step).
import {
  MFA_SETUP_REQUIRED,
  SETUP_PATH,
  SIGN_IN_PATH,
  adminUrl,
} from './two-step';

declare const __BACKEND_URL__: string;
declare const __BASE__: string;

/** True when a response means "signed out" and the browser should go to the
 *  login page: a 401 from the backend's /admin/* API, unless the user is
 *  already on a signed-out page (login, password reset, invite). */
export function isSignedOutResponse(
  requestUrl: string,
  status: number,
  backendUrl: string,
  location: { href: string; pathname: string },
): boolean {
  if (status !== 401) return false;
  if (
    /\/(login|sign-in|two-step-setup|reset-password|invite)(\/|$)/.test(
      location.pathname,
    )
  ) {
    return false;
  }
  const backend = new URL(backendUrl || location.href, location.href);
  const url = new URL(requestUrl, backend);
  // /admin/users/me is Mercur's own session probe: on a 401 its route guard
  // sends the user to login WITH the page they asked for, so they land back on
  // it. A full reload from here would beat it and lose that page.
  return (
    url.origin === backend.origin &&
    url.pathname.startsWith('/admin/') &&
    url.pathname !== '/admin/users/me'
  );
}

// Asked before this module's React app exists, so no i18n: both languages.
export const INVITE_SIGN_OUT_PROMPT =
  'You are signed in to the admin. Sign out to accept this invite?\n\n你已登录后台。要登出以接受此邀请吗？';

export const INVITE_SIGN_OUT_FAILED =
  'Could not sign you out. Sign out of the admin, then open this invite link again.' +
  ' / 无法登出。请先登出后台，再重新打开此邀请链接。';

const loginUrl = () => adminUrl(`${SIGN_IN_PATH}?reason=Unauthorized`);

/** True for a backend /admin/* answer that this login must set up an
 *  authenticator first, unless the setup page is already open. */
export function isSetupRequiredResponse(
  requestUrl: string,
  status: number,
  type: unknown,
  backendUrl: string,
  location: { href: string; pathname: string },
): boolean {
  if (status !== 403 || type !== MFA_SETUP_REQUIRED) return false;
  if (location.pathname.endsWith(SETUP_PATH)) return false;
  const backend = new URL(backendUrl || location.href, location.href);
  const url = new URL(requestUrl, backend);
  return url.origin === backend.origin && url.pathname.startsWith('/admin/');
}

/** True for a visit to an invite link. Medusa refuses to accept an invite
 *  from a browser signed in to the admin ("already authenticated"), and the
 *  page shows that as "invalid or expired" after it has already made the new
 *  login, which then blocks every retry (elston@, 2026-11-07). So a signed-in
 *  visitor is asked to sign out first; asked, so that a link sent by anyone
 *  cannot sign an admin out unawares. */
export function isInviteVisit(
  pathname: string,
  search: string,
  basePath: string,
): boolean {
  const root = basePath.replace(/\/+$/, '');
  return (
    pathname.replace(/\/+$/, '') === `${root}/invite` &&
    new URLSearchParams(search).has('token')
  );
}

/** Our sign-in page for a visit to Mercur's login page, else null. */
export function signInInstead(
  pathname: string,
  search: string,
  basePath: string,
): string | null {
  const root = basePath.replace(/\/+$/, '');
  if (pathname.replace(/\/+$/, '') !== `${root}/login`) return null;
  return `${root}${SIGN_IN_PATH}${search}`;
}

if (typeof window !== 'undefined') {
  const fetchOriginal = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const res = await fetchOriginal(input, init);
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (
      isSignedOutResponse(url, res.status, __BACKEND_URL__, window.location)
    ) {
      window.location.href = loginUrl();
    } else if (res.status === 403) {
      const type = await res
        .clone()
        .json()
        .then((body: { type?: unknown }) => body?.type)
        .catch(() => undefined);
      if (
        isSetupRequiredResponse(
          url,
          res.status,
          type,
          __BACKEND_URL__,
          window.location,
        )
      ) {
        window.location.href = adminUrl(SETUP_PATH);
      }
    }
    return res;
  };

  const leaveLogin = () => {
    const to = signInInstead(
      window.location.pathname,
      window.location.search,
      typeof __BASE__ !== 'undefined' ? __BASE__ : '/',
    );
    if (to) window.location.replace(to);
  };
  for (const method of ['pushState', 'replaceState'] as const) {
    const original = window.history[method].bind(window.history);
    window.history[method] = (...args: Parameters<History['pushState']>) => {
      original(...args);
      leaveLogin();
    };
  }
  window.addEventListener('popstate', leaveLogin);
  leaveLogin();

  if (
    isInviteVisit(
      window.location.pathname,
      window.location.search,
      typeof __BASE__ !== 'undefined' ? __BASE__ : '/',
    )
  ) {
    void (async () => {
      // Signed in: 200, or 403 for a login still to set up its authenticator.
      const me = await fetchOriginal(`${__BACKEND_URL__}/admin/users/me`, {
        credentials: 'include',
      }).catch(() => null);
      if (!me || (me.status !== 200 && me.status !== 403)) return;
      if (!window.confirm(INVITE_SIGN_OUT_PROMPT)) return;
      const out = await fetchOriginal(`${__BACKEND_URL__}/auth/session`, {
        method: 'DELETE',
        credentials: 'include',
      }).catch(() => null);
      // Still signed in, the invite would fail after making the login.
      if (!out?.ok) window.alert(INVITE_SIGN_OUT_FAILED);
    })();
  }
}

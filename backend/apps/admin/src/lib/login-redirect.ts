// An expired admin login answers 401 to every /admin/* call. Mercur's own API
// helper sends the browser to its login page when that happens; our direct
// fetches (admin-rest, automation, assistant) did not, so staff kept a page
// that looked fine while every save and upload showed "Unauthorized" (Anson's
// delivery photos, 2026-10-30). Imported first in main.tsx, this wraps
// window.fetch once so every caller gets Mercur's behaviour.
//
// 401 only: a missing permission is a 403 and must stay on the page.

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
  if (/\/(login|reset-password|invite)(\/|$)/.test(location.pathname)) {
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

const loginUrl = () =>
  `${(typeof __BASE__ !== 'undefined' ? __BASE__ : '/').replace(/\/+$/, '')}/login?reason=Unauthorized`;

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
    }
    return res;
  };
}

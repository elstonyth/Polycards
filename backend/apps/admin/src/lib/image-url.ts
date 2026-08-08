// Card/pack `image` values come in two shapes:
//   - Seeded art = storefront-origin-relative paths (e.g. /cdn/cards/x.webp,
//     /home/hero/slabs/x.webp, /images/claw/x-icon.webp) served by the storefront.
//   - Admin uploads = absolute backend URLs (http://localhost:9000/static/...).
// The admin SPA runs on a different origin than the storefront, so a relative
// path resolves against the admin origin and 404s. We resolve images against the
// SAME host the dashboard was loaded from — localhost when developing locally,
// or the LAN/VPN IP when previewing from another machine:
//   - relative path   -> the storefront on this host, port 4000
//   - localhost abs.   -> rehosted to this host (keeps port + path; covers
//                         uploads at :9000/static and any localhost:4000 links)
// RENDER-ONLY — never persist the resolved value.

// Port the storefront is served on locally (see `next ... -p 4000`).
const STOREFRONT_PORT = 4000;

// Prod storefront origin, baked into the bundle at build time (vite define from
// MERCUR_STOREFRONT_URL). In prod the storefront is a SEPARATE domain from the
// admin, so storefront-relative asset paths (/cdn, /home, /images) must resolve
// against it — not against the admin host on :4000 (the local-dev assumption,
// which 404s in prod). Empty when unset (local dev) -> fall back to host:4000.
declare const __STOREFRONT_URL__: string;
const STOREFRONT_ORIGIN =
  typeof __STOREFRONT_URL__ !== "undefined" ? __STOREFRONT_URL__ : "";

function dashboardHost(): { proto: string; host: string } {
  if (typeof window !== "undefined" && window.location) {
    return { proto: window.location.protocol, host: window.location.hostname };
  }
  return { proto: "http:", host: "localhost" };
}

// Schemes this helper will hand to an <img src>. Anything with a scheme that
// is not http(s) or an image data: URI is refused outright.
//
// Not exploitable today — all ~28 call sites are <img src>, and no current
// browser runs javascript: from one — but the values reaching here are not all
// ours: PriceCharting responses and admin free-text both flow in. Refusing the
// scheme at the one shared helper is cheaper than auditing every future sink,
// and the first call site to use an href would otherwise make it live.
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const SAFE_SCHEME = /^(?:https?:|data:image\/)/i;

/** Relative paths (no scheme) are fine; a scheme must be http(s) or data:image. */
function isSafeImageUrl(url: string): boolean {
  return !HAS_SCHEME.test(url) || SAFE_SCHEME.test(url);
}

export function resolveImageUrl(url: string | null | undefined): string {
  if (!url) return "";
  // ABOVE the data: passthrough on purpose: put it below and `data:text/html`
  // would walk straight past the check.
  if (!isSafeImageUrl(url)) return "";
  if (url.startsWith("data:")) return url;

  const { proto, host } = dashboardHost();

  // Storefront-relative path -> serve from the storefront. Prod: the baked
  // storefront origin (separate domain). Local dev: same host on :4000.
  if (url.startsWith("/")) {
    const base = STOREFRONT_ORIGIN
      ? STOREFRONT_ORIGIN.replace(/\/$/, "")
      : `${proto}//${host}:${STOREFRONT_PORT}`;
    return `${base}${url}`;
  }

  // Absolute localhost/127.0.0.1 URL (e.g. admin uploads) -> swap in the current
  // host so it loads over the LAN/VPN too (keeps the original port + path).
  if (/^https?:\/\/(localhost|127\.0\.0\.1)([:/]|$)/i.test(url)) {
    return url.replace(/^(https?:\/\/)(localhost|127\.0\.0\.1)/i, `$1${host}`);
  }

  // Any other absolute URL (real CDN, etc.) -> leave untouched.
  return url;
}

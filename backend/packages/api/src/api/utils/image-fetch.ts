// SSRF-guarded image fetcher — moved out of bake-slab.ts (plan 114) so a
// second caller (the Telegram apex board's card-art fetch) doesn't have to
// re-inline a bare `fetch` for an image URL, which is the exact class of bug
// this module exists to close. Shared by bake-slab.ts (admin-set
// slab_frame_url / card.image) and modules/packs/telegram.ts
// (blackBackedPhoto).

const FETCH_TIMEOUT_MS = 10_000;

// ADMIN-ONLY defense-in-depth — this is not an attacker-reachable path like the
// customer avatar route; it is adequate for that threat model, not a hard bound
// on every allocation. fetchBytes caps bytes (20 MB) but NOT dimensions, so a
// low-entropy megapixel image from an admin-set slab_frame_url / card.image
// would otherwise drive a full-raster decode. This ceiling bounds the decode
// INPUT only; callers bound their own composite/output canvases separately
// (bake-slab.ts's MAX_FRAME_WIDTH / MAX_FRAME_HEIGHT). 32 MP refuses the
// 64 MP+ bomb class, and bake-slab's card/frame validate profiles cap each
// side at 5500 (<=30.25 MP) so admin-UPLOADED art always stays under it —
// validation and bake agree, no silent bake failure. Best-effort: an
// over-limit image fails its caller's decode and that caller logs.
export const MAX_DECODE_PIXELS = 32_000_000;

// Byte cap for a fetched image — the SAME number as media/validate.ts's
// IMAGE_RULES.maxBytes (20 MB, also enforced by multer at the edge), kept as
// its own literal rather than importing IMAGE_RULES here: that config carries
// a dozen unrelated per-kind profile rules (card/pack/display/sprite/…) that
// don't belong in a generic fetch-bytes module. bake-slab.ts's own composite
// upload-size check still uses IMAGE_RULES.maxBytes directly — this mirrors
// it, it does not replace it.
const MAX_FETCH_BYTES = 20 * 1024 * 1024;

// True for an IPv4 dotted-quad in a loopback / private / link-local range. Node's
// WHATWG URL parser canonicalizes integer/hex/octal IPv4 forms (0x7f000001,
// 2130706433, 0177.0.0.1) to dotted-quad in `hostname`, so checking the parsed
// hostname catches those obfuscations too.
const isPrivateIpv4 = (host: string): boolean => {
  const parts = host.split('.').map(Number);
  if (
    parts.length !== 4 ||
    parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)
  ) {
    return false;
  }
  const [a, b] = parts;
  return (
    a === 0 || // 0.0.0.0/8 ("this host")
    a === 10 || // 10/8
    a === 127 || // loopback
    (a === 169 && b === 254) || // link-local + cloud metadata (169.254.169.254)
    (a === 172 && b >= 16 && b <= 31) || // 172.16/12
    (a === 192 && b === 168) // 192.168/16
  );
};

// Block hosts that a fetch should never reach: loopback, RFC-1918, link-local,
// and the cloud metadata endpoint. IPv6 handled by prefix (::1 loopback, fc/fd
// ULA, fe80 link-local); brackets stripped first.
const isPrivateHost = (hostname: string): boolean => {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.includes(':')) {
    return (
      host === '::1' ||
      host === '::' ||
      // IPv4-mapped IPv6 (::ffff:a.b.c.d) — a classic SSRF-filter bypass. Node
      // renders the embedded v4 as hex (::ffff:7f00:1), so block the whole
      // prefix; a legit card/frame image never uses a mapped-v6 literal.
      host.startsWith('::ffff:') ||
      host.startsWith('fc') ||
      host.startsWith('fd') ||
      // fe80::/10 spans fe80–febf, not just the literal fe80 prefix.
      /^fe[89ab]/.test(host)
    );
  }
  return isPrivateIpv4(host);
};

// The origin of OUR OWN local file provider, trusted even though it's a loopback
// address. When S3 (public CDN) is NOT configured — dev/test — Medusa's built-in
// file provider serves uploads at the backend origin (default http://localhost:9000),
// so a card/frame image URL is a loopback URL the SSRF guard below would otherwise
// block, leaving graded cards unbaked. Gate this on S3_FILE_URL being unset — the
// SAME condition that decides files live on the local provider — so prod (S3 set,
// files on the public CDN) keeps loopback fully blocked with no NODE_ENV reliance.
const localFileOrigin = (): string | null => {
  if (process.env.S3_FILE_URL) return null; // prod: files are on the public CDN
  try {
    return new URL(process.env.MEDUSA_BACKEND_URL ?? 'http://localhost:9000')
      .origin;
  } catch {
    return null;
  }
};

// SSRF guard for the URLs this module fetches server-side (admin-supplied
// slab_frame_url + a card's image, and the Telegram apex board's card art).
// Card/frame images are OUR stored copies (CDN host or a storefront-relative
// path) or, at worst, an admin-pasted PUBLIC image URL — never an internal
// address. So block only fetches to internal/metadata hosts; every public host
// stays allowed. Fails OPEN for public hosts by design: a strict CDN-host
// allowlist would break baking of legit images (and collapses to "relative
// only" when S3_FILE_URL is unset in dev/test) — worse than this admin-auth-
// gated, low-severity SSRF.
// ponytail: literal-IP + hostname block only. A hostname (or IPv4-mapped IPv6
// like ::ffff:127.0.0.1) that RESOLVES to a private IP is a documented residual
// (DNS rebind) — add a resolve-then-check guard if this ever fetches
// less-trusted input.
export function isAllowedImageUrl(url: string): boolean {
  // Storefront-relative path — not a network egress target. (Excludes
  // protocol-relative //host, which new URL() rejects below anyway.)
  if (url.startsWith('/') && !url.startsWith('//')) return true;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  // Our own local file provider (dev/test only) — the one loopback origin we
  // must reach to bake our own stored card/frame images.
  const localOrigin = localFileOrigin();
  if (localOrigin && parsed.origin === localOrigin) return true;
  return !isPrivateHost(parsed.hostname);
}

// Trusted base for storefront-relative image paths (e.g. '/cdn/cards/x.webp').
// Operator config — the same source password-reset.ts builds links from — not
// admin input, so resolving against it (even localhost in dev) is not an SSRF
// widening: a relative path can only ever land on our own storefront.
const assetOrigin = (): string =>
  (process.env.STOREFRONT_URL ?? 'http://localhost:4000').replace(/\/+$/, '');

const MAX_REDIRECTS = 3;

export const fetchBytes = async (url: string): Promise<Buffer | null> => {
  // Fail closed (null → caller warns + falls back to the bundled default frame,
  // or skips the card) rather than fetching an internal host.
  if (!isAllowedImageUrl(url)) return null;
  // isAllowedImageUrl passes storefront-relative paths, but Node's fetch()
  // throws on them — resolve against the trusted storefront origin so
  // relative card images actually bake instead of being silently skipped.
  let target = url.startsWith('/') ? `${assetOrigin()}${url}` : url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let resp: Response;
    try {
      resp = await fetch(target, {
        // fetch() follows 3xx by default, so a public image URL could bounce
        // to a blocked internal host AFTER the guard ran. Walk redirects
        // manually and re-validate every hop instead.
        redirect: 'manual',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch {
      return null;
    }
    if (resp.status >= 300 && resp.status < 400) {
      const loc = resp.headers.get('location');
      if (!loc) return null;
      let next: URL;
      try {
        next = new URL(loc, target); // Location may be relative to the hop
      } catch {
        return null;
      }
      if (!isAllowedImageUrl(next.toString())) return null;
      target = next.toString();
      continue;
    }
    if (!resp.ok) return null;
    return await readCapped(resp);
  }
  return null; // redirect chain longer than MAX_REDIRECTS — fail closed
};

/**
 * Read the body, abandoning it the moment it exceeds MAX_FETCH_BYTES.
 *
 * This used to be `Buffer.from(await resp.arrayBuffer())` followed by a length
 * check, which measured a body it had ALREADY materialised in full — a 2 GB
 * response was 2 GB resident before being rejected, on a 512 MB-class box.
 * Content-Length is checked first where the server offers one, but it is
 * advisory and absent entirely under chunked transfer, so the running total
 * during the read is the real bound.
 *
 * Null on any failure (over-limit, empty, mid-stream network error), matching
 * fetchBytes' fail-closed contract — every caller already treats null as
 * "skip / fall back", never as an error to surface.
 */
async function readCapped(resp: Response): Promise<Buffer | null> {
  // Cheap pre-check: a truthful server saves us opening the stream at all.
  const declared = Number(resp.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_FETCH_BYTES) {
    await resp.body?.cancel().catch(() => {});
    return null;
  }
  if (!resp.body) return null;

  const chunks: Buffer[] = [];
  let total = 0;
  const reader = resp.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_FETCH_BYTES) {
        // Stop the transfer rather than draining it: the peer is either
        // hostile or misconfigured, and either way we are not going to use it.
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(Buffer.from(value));
    }
  } catch {
    // Timeout (AbortSignal) or a socket error mid-body.
    return null;
  }
  return total > 0 ? Buffer.concat(chunks, total) : null;
}

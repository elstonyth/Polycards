import { createHash } from 'node:crypto';
import type { MedusaContainer } from '@medusajs/framework/types';
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils';
import {
  deleteFilesWorkflow,
  updateProductsWorkflow,
  uploadFilesWorkflow,
} from '@medusajs/medusa/core-flows';
import sharp from 'sharp';
import { PACKS_MODULE } from '../../../modules/packs';
import type PacksModuleService from '../../../modules/packs/service';
import { IMAGE_RULES } from './validate';
import { DEFAULT_SLAB_FRAME_B64 } from './slab-frame-default';

// Server-side slab bake: composite the admin frame + card photo into ONE
// stored webp (spec 2026-07-07-graded-slab-baked-image-design.md §B). The
// storefront renders this single image — no runtime two-layer stack.

// Card-window insets as fractions of the frame box, and the storefront clip's
// corner radii. Printed by scripts/process-slab-frame.mjs for the default
// frame asset; admin-uploaded frames must keep this geometry (PR #81 contract,
// mirrored in the admin Storefront page copy).
export const SLAB_WINDOW = {
  top: 0.2833,
  left: 0.1047,
  right: 0.1047,
  bottom: 0.0666,
} as const;
const CORNER_RX = 0.048; // of window width
const CORNER_RY = 0.034; // of window height
const MAX_FRAME_WIDTH = 1600;
// Frames are downscaled to fit BOTH bounds. Height matters independently: a
// frame narrower than MAX_FRAME_WIDTH skips the width cap entirely, so without
// this a pathologically tall one would balloon the create canvas + composite
// (fw×fh RGBA) below. 4000 leaves the width the binding constraint for real
// slab-proportioned art (~0.62 ratio ⇒ 1600×2580) and bounds the canvas.
const MAX_FRAME_HEIGHT = 4000;
const FETCH_TIMEOUT_MS = 10_000;

// ADMIN-ONLY defense-in-depth — this is not an attacker-reachable path like the
// customer avatar route; it is adequate for that threat model, not a hard bound
// on every allocation. fetchBytes caps bytes (20 MB) but NOT dimensions, so a
// low-entropy megapixel image from an admin-set slab_frame_url / card.image
// would otherwise drive a full-raster decode. This ceiling bounds the decode
// INPUT only; the composite canvas is bounded separately by MAX_FRAME_WIDTH /
// MAX_FRAME_HEIGHT. 32 MP refuses the 64 MP+ bomb class, and the frame/card
// validate profiles cap each side at 5500 (<=30.25 MP) so admin-UPLOADED art
// always stays under it — validation and bake agree, no silent bake failure.
// Best-effort: an over-limit image fails its bake and logs (bakeSlabImage catch).
const MAX_DECODE_PIXELS = 32_000_000;

export type BakedSlab = { url: string; key: string };

type Logger = { info: (m: string) => void; warn: (m: string) => void };
const loggerOf = (container: MedusaContainer): Logger =>
  container.resolve(ContainerRegistrationKeys.LOGGER);

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

// SSRF guard for the URLs this module fetches server-side (admin-supplied
// slab_frame_url + a card's image). Card/frame images are OUR stored copies
// (CDN host or a storefront-relative path) or, at worst, an admin-pasted PUBLIC
// image URL — never an internal address. So block only fetches to
// internal/metadata hosts; every public host stays allowed. Fails OPEN for
// public hosts by design: a strict CDN-host allowlist would break baking of
// legit images (and collapses to "relative only" when S3_FILE_URL is unset in
// dev/test) — worse than this admin-auth-gated, low-severity SSRF.
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
    const bytes = Buffer.from(await resp.arrayBuffer());
    return bytes.length > 0 && bytes.length <= IMAGE_RULES.maxBytes
      ? bytes
      : null;
  }
  return null; // redirect chain longer than MAX_REDIRECTS — fail closed
};

// The frame to bake with: the admin-configured URL when it is an absolute
// http(s) URL, else the bundled default (relative paths are storefront-only
// and unfetchable from here — spec §B.1).
export const resolveFrameBytes = async (
  container: MedusaContainer,
): Promise<Buffer> => {
  const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
  const { slab_frame_url } = await packs.siteSettings();
  if (slab_frame_url && /^https?:\/\//.test(slab_frame_url)) {
    const bytes = await fetchBytes(slab_frame_url);
    if (bytes) return bytes;
    loggerOf(container).warn(
      `bake-slab: frame '${slab_frame_url}' unfetchable — using bundled default`,
    );
  } else if (slab_frame_url) {
    loggerOf(container).warn(
      `bake-slab: frame '${slab_frame_url}' is a relative path — using bundled default`,
    );
  }
  return Buffer.from(DEFAULT_SLAB_FRAME_B64, 'base64');
};

// Pure composite: photo cover-fitted into the frame's card window (corners
// rounded like the old storefront clip), frame layered on top, webp out.
export async function composeSlab(
  frameBytes: Buffer,
  photoBytes: Buffer,
): Promise<Buffer> {
  const frameMeta = await sharp(frameBytes, {
    limitInputPixels: MAX_DECODE_PIXELS,
  }).metadata();
  let fw = frameMeta.width ?? 0;
  let fh = frameMeta.height ?? 0;
  if (!fw || !fh) throw new Error('frame image has no dimensions');
  let frame = frameBytes;
  // Scale to fit inside BOTH bounds, aspect preserved, and never upscale (a
  // small frame stays untouched). Downscaling — rather than rejecting — keeps
  // an oversized frame bakeable instead of failing it silently.
  const scale = Math.min(1, MAX_FRAME_WIDTH / fw, MAX_FRAME_HEIGHT / fh);
  if (scale < 1) {
    fw = Math.max(1, Math.round(fw * scale));
    fh = Math.max(1, Math.round(fh * scale));
    frame = await sharp(frameBytes, { limitInputPixels: MAX_DECODE_PIXELS })
      .resize({ width: fw, height: fh })
      .png()
      .toBuffer();
  }
  // The clamps above keep a wildly-skewed frame (aspect outside ~[0.0004, 2500],
  // only reachable via an un-validated admin-set URL) from scaling to 0px — but
  // baking a 1px-tall slab would be a silent nonsense result. Fail it instead:
  // bakeSlabImage catches and logs, leaving slab_image untouched.
  if (fw < 2 || fh < 2) {
    throw new Error(`frame aspect is degenerate after scaling (${fw}x${fh})`);
  }
  const left = Math.round(fw * SLAB_WINDOW.left);
  const top = Math.round(fh * SLAB_WINDOW.top);
  const winW = fw - left - Math.round(fw * SLAB_WINDOW.right);
  const winH = fh - top - Math.round(fh * SLAB_WINDOW.bottom);
  const rx = Math.round(winW * CORNER_RX);
  const ry = Math.round(winH * CORNER_RY);
  const mask = Buffer.from(
    `<svg width="${winW}" height="${winH}"><rect width="${winW}" height="${winH}" rx="${rx}" ry="${ry}" fill="#fff"/></svg>`,
  );
  const photo = await sharp(photoBytes, { limitInputPixels: MAX_DECODE_PIXELS })
    .resize(winW, winH, { fit: 'cover' })
    .composite([{ input: mask, blend: 'dest-in' }])
    .png()
    .toBuffer();
  return sharp({
    create: {
      width: fw,
      height: fh,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([
      { input: photo, left, top },
      { input: frame, left: 0, top: 0 },
    ])
    .webp({ quality: 90, alphaQuality: 90 })
    .toBuffer();
}

// Bake one card. Best-effort by contract: ANY failure logs a warning and
// returns null — a bake must never fail a card save (spec §B.5).
export async function bakeSlabImage(
  container: MedusaContainer,
  card: { handle: string; image: string },
  frameBytes?: Buffer,
): Promise<BakedSlab | null> {
  const logger = loggerOf(container);
  try {
    const photo = await fetchBytes(card.image);
    if (!photo) {
      logger.warn(
        `bake-slab: photo unfetchable for '${card.handle}' (${card.image})`,
      );
      return null;
    }
    // A caller looping over many cards (rebakeAllGradedCards) resolves the
    // frame once and passes it down — a mid-loop frame-fetch failure must not
    // silently bake the remaining cards against the bundled default while
    // still counting them ok.
    const frame = frameBytes ?? (await resolveFrameBytes(container));
    const out = await composeSlab(frame, photo);
    if (out.length > IMAGE_RULES.maxBytes) {
      logger.warn(
        `bake-slab: composite exceeds size limit for '${card.handle}'`,
      );
      return null;
    }
    const hash = createHash('sha256').update(out).digest('hex').slice(0, 8);
    const { result } = await uploadFilesWorkflow(container).run({
      input: {
        files: [
          {
            filename: `slab-${card.handle}-${hash}.webp`,
            mimeType: 'image/webp',
            content: out.toString('base64'),
            access: 'public',
          },
        ],
      },
    });
    const stored = result?.[0];
    if (!stored?.url || !stored?.id) {
      logger.warn(`bake-slab: upload returned no url/id for '${card.handle}'`);
      return null;
    }
    return { url: stored.url, key: stored.id };
  } catch (e) {
    logger.warn(
      `bake-slab: failed for '${card.handle}': ${e instanceof Error ? e.message : String(e)}`,
    );
    return null;
  }
}

// Delete a previous composite (decision #8) — best-effort; a failed delete
// just leaves an orphan.
export async function deleteSlabFile(
  container: MedusaContainer,
  key: string | null | undefined,
): Promise<void> {
  if (!key) return;
  try {
    await deleteFilesWorkflow(container).run({ input: { ids: [key] } });
  } catch (e) {
    loggerOf(container).warn(
      `bake-slab: failed to delete old composite '${key}': ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

// Mirror slab_image (URL only, never slab_image_key) into the same-handle
// Product's metadata — src/lib/data/products.ts reads that mirror for the
// marketplace grid. Card-edit (create/update-card) already writes its own
// mirror on the edit path; this covers every OTHER path that changes
// Card.slab_image (frame-swap rebake, repull, delete) so the grid never
// points at a composite that's been overwritten or deleted out from under
// it. Best-effort — a mirror failure must never fail the caller, which has
// already committed its own change.
export async function mirrorSlabToProduct(
  container: MedusaContainer,
  handle: string,
  url: string | null,
): Promise<void> {
  try {
    const productModule = container.resolve(Modules.PRODUCT);
    const [product] = await productModule.listProducts({ handle }, { take: 1 });
    if (!product) return; // defensive-upsert cards may have no Product yet
    await updateProductsWorkflow(container).run({
      input: {
        products: [
          {
            id: product.id,
            metadata: { ...(product.metadata ?? {}), slab_image: url },
          },
        ],
      },
    });
  } catch (e) {
    loggerOf(container).warn(
      `bake-slab: failed to mirror slab_image for '${handle}': ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

// Re-bake EVERY graded card — the frame-swap trigger and the backfill script
// share this. Per-card failures don't stop the loop (spec §F).
// ponytail: sequential sync loop — ~17 graded cards today; move to a queue if
// the catalog reaches hundreds.
export async function rebakeAllGradedCards(
  container: MedusaContainer,
): Promise<{ ok: number; failed: number }> {
  const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
  const logger = loggerOf(container);
  const cards = (await packs.listCards({}, { take: 10_000 })).filter(
    (c) => c.grader.trim() !== '',
  );
  let ok = 0;
  let failed = 0;
  if (cards.length === 0) return { ok, failed };
  // Resolve the frame ONCE for the whole loop (reviewer finding): re-resolving
  // per card meant a mid-loop frame-fetch failure silently baked the
  // remaining cards against the bundled default while still counting them ok.
  const frameBytes = await resolveFrameBytes(container);
  for (const card of cards) {
    const baked = await bakeSlabImage(
      container,
      { handle: card.handle, image: card.image },
      frameBytes,
    );
    if (!baked) {
      failed++;
      continue;
    }
    try {
      const oldKey = card.slab_image_key ?? null;
      await packs.updateCards([
        { id: card.id, slab_image: baked.url, slab_image_key: baked.key },
      ]);
      await mirrorSlabToProduct(container, card.handle, baked.url);
      if (oldKey && oldKey !== baked.key) {
        await deleteSlabFile(container, oldKey);
      }
      ok++;
      logger.info(`bake-slab: ✓ ${card.handle} → ${baked.url}`);
    } catch (e) {
      logger.warn(
        `bake-slab: persist failed for '${card.handle}': ${e instanceof Error ? e.message : String(e)}`,
      );
      failed++;
      // Nothing references the just-uploaded composite when the DB write
      // fails — reclaim it instead of orphaning one file per failed card
      // (this loop backs the frame swap AND the backfill, so failures repeat).
      await deleteSlabFile(container, baked.key);
    }
  }
  return { ok, failed };
}

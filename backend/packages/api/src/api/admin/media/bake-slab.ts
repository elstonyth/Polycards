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
const FETCH_TIMEOUT_MS = 10_000;

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
      host.startsWith('fc') ||
      host.startsWith('fd') ||
      host.startsWith('fe80')
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

const fetchBytes = async (url: string): Promise<Buffer | null> => {
  // Fail closed (null → caller warns + falls back to the bundled default frame,
  // or skips the card) rather than fetching an internal host.
  if (!isAllowedImageUrl(url)) return null;
  let resp: Response;
  try {
    resp = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch {
    return null;
  }
  if (!resp.ok) return null;
  const bytes = Buffer.from(await resp.arrayBuffer());
  return bytes.length > 0 && bytes.length <= IMAGE_RULES.maxBytes
    ? bytes
    : null;
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
  const frameMeta = await sharp(frameBytes).metadata();
  let fw = frameMeta.width ?? 0;
  let fh = frameMeta.height ?? 0;
  if (!fw || !fh) throw new Error('frame image has no dimensions');
  let frame = frameBytes;
  if (fw > MAX_FRAME_WIDTH) {
    fh = Math.round((fh * MAX_FRAME_WIDTH) / fw);
    fw = MAX_FRAME_WIDTH;
    frame = await sharp(frameBytes)
      .resize({ width: fw, height: fh })
      .png()
      .toBuffer();
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
  const photo = await sharp(photoBytes)
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
      logger.warn(`bake-slab: photo unfetchable for '${card.handle}' (${card.image})`);
      return null;
    }
    // A caller looping over many cards (rebakeAllGradedCards) resolves the
    // frame once and passes it down — a mid-loop frame-fetch failure must not
    // silently bake the remaining cards against the bundled default while
    // still counting them ok.
    const frame = frameBytes ?? (await resolveFrameBytes(container));
    const out = await composeSlab(frame, photo);
    if (out.length > IMAGE_RULES.maxBytes) {
      logger.warn(`bake-slab: composite exceeds size limit for '${card.handle}'`);
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
    const [product] = await productModule.listProducts(
      { handle },
      { take: 1 },
    );
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

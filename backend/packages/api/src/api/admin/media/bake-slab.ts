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
import { renderLabelSvg, type SlabLabelFields } from './label';
import { ensureLabelFont } from './label-font';

// Server-side slab bake: composite the admin frame + card photo into ONE
// stored webp (spec 2026-07-07-graded-slab-baked-image-design.md §B). The
// storefront renders this single image — no runtime two-layer stack.

// Card-window insets as fractions of the frame box, and the storefront clip's
// corner radii. Printed by scripts/process-slabframe-v2.mjs for the default
// frame asset; admin-uploaded frames must keep this geometry (PR #81 contract,
// mirrored in the admin Storefront page copy).
export const SLAB_WINDOW = {
  top: 0.2707,
  left: 0.1094,
  right: 0.1087,
  // Documentation-only anchor: composeSlab is top-aligned (spare recess at the
  // bottom), so it reads top/left/right but NOT bottom. Kept as the measured
  // fourth inset of the geometry contract (PR #81), so a re-measure records all
  // four sides in one place.
  bottom: 0.0822,
} as const;
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

// Card-scan crop system (operator-specified, rebuilt 2026-07-16, verified on
// magenta — docs/research/verify-clean-card.png):
//   1. scan the white edge and peel the TINY edge only: per-side bright-ring
//      peel (max 3px) + one unconditional 1px anti-alias contact ring;
//   2. re-cut the corners to a real Pokémon die-cut (r = 4.76% of width,
//      circular — same angle, same curve), cutting INSIDE the scan's own
//      fringed arc so its white anti-alias line goes with it;
//   3. the "white bright layer" is opaque white matting on the arcs/edges —
//      alpha-binarize alone cannot catch it (those pixels are opaque); the
//      peel + arc re-cut remove it;
//   4. verify: the bright-peel rule (min(r,g,b) > 200 for >=60% of a ring)
//      can never eat a card border — the catalog borders measure gray 108 /
//      silver 181 / pale 156; hard-fail if any side loses more than 4px;
//   5. everything outside the arc ends fully transparent.
async function cleanScan(bytes: Buffer): Promise<Buffer> {
  const { data, info } = await sharp(bytes, {
    limitInputPixels: MAX_DECODE_PIXELS,
  })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const w = info.width;
  const h = info.height;
  const ch = info.channels;
  // semi-transparent halo → fully transparent (interior is fully opaque)
  for (let p = 0; p < w * h; p++) {
    const i = p * ch;
    data[i + 3] = data[i + 3] >= 250 ? 255 : 0;
  }
  // exact content bbox — nothing shaved
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * ch + 3] === 255) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) throw new Error('card scan is fully transparent');
  const bright = (x: number, y: number): boolean => {
    const i = (y * w + x) * ch;
    return (
      data[i + 3] === 255 && Math.min(data[i], data[i + 1], data[i + 2]) > 200
    );
  };
  const rowBright = (y: number): boolean => {
    let br = 0;
    let n = 0;
    for (let x = x0; x <= x1; x += 2) {
      if (data[(y * w + x) * ch + 3] !== 255) continue;
      n++;
      if (bright(x, y)) br++;
    }
    return n > 0 && br / n >= 0.6;
  };
  const colBright = (x: number): boolean => {
    let br = 0;
    let n = 0;
    for (let y = y0; y <= y1; y += 2) {
      if (data[(y * w + x) * ch + 3] !== 255) continue;
      n++;
      if (bright(x, y)) br++;
    }
    return n > 0 && br / n >= 0.6;
  };
  const peel = { t: 0, b: 0, l: 0, r: 0 };
  while (peel.t < 3 && rowBright(y0 + peel.t)) peel.t++;
  while (peel.b < 3 && rowBright(y1 - peel.b)) peel.b++;
  while (peel.l < 3 && colBright(x0 + peel.l)) peel.l++;
  while (peel.r < 3 && colBright(x1 - peel.r)) peel.r++;
  for (const [side, v] of Object.entries(peel)) {
    if (v + 1 > 4) throw new Error(`over-trim on side '${side}': ${v + 1}px`);
  }
  y0 += peel.t + 1;
  y1 -= peel.b + 1;
  x0 += peel.l + 1;
  x1 -= peel.r + 1;
  const cw = x1 - x0 + 1;
  const chh = y1 - y0 + 1;
  // real Pokémon die-cut: 3mm of 63mm = 4.76% of width, circular
  const r = Math.round(cw * 0.0476);
  const mask = Buffer.from(
    `<svg width="${cw}" height="${chh}"><rect width="${cw}" height="${chh}" rx="${r}" ry="${r}" fill="#fff"/></svg>`,
  );
  return sharp(data, { raw: { width: w, height: h, channels: 4 } })
    .extract({ left: x0, top: y0, width: cw, height: chh })
    .composite([{ input: mask, blend: 'dest-in' }])
    .png()
    .toBuffer();
}

// Pure composite: photo width-fitted at natural aspect into the frame's card
// window (nothing cropped, full die-cut corner curves visible), frame layered
// on top, then the per-card PSA label text (photo → frame → label, spec §6).
// No label fields → today's two-layer behaviour (photo + frame, used by
// geometry tests and any raw composite).
export async function composeSlab(
  frameBytes: Buffer,
  photoBytes: Buffer,
  label?: SlabLabelFields,
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

  const cleaned = await cleanScan(photoBytes);
  const cMeta = await sharp(cleaned).metadata();
  const cw = cMeta.width ?? 0;
  const chh = cMeta.height ?? 0;
  if (!cw || !chh) throw new Error('card photo has no dimensions');
  const inset = Math.max(2, Math.round(winW * 0.0063)); // recess gap (~8px @1600)
  const cardW = winW - inset * 2;
  const cardH = Math.round((chh * cardW) / cw);
  const cardTop = top + inset;
  // Degenerate narrow-tall scan (e.g. 100x320,000) passes the ≤20MB/≤32MP
  // input guards but blows cardH up to millions of px BEFORE any containment
  // check — an OOM-sized resize allocation below (line ~389), escaping
  // per-card fault isolation. Bound against the FRAME canvas (fh), not the
  // nominal window height: under the shipped user-1600 geometry a real PSA
  // card (~0.713 aspect) width-fitted into the window can overflow the window
  // height by a few px while still fitting inside the frame — so bounding on
  // the window height would false-positive on legitimate bakes. fh is the
  // same bound sharp's composite() enforces below, just checked before the
  // expensive resize instead of after it.
  if (cardTop + cardH > fh) {
    throw new Error(
      `card scan too tall for frame: fitted ${cardW}x${cardH} at top ${cardTop} exceeds frame height ${fh} (source ${cw}x${chh})`,
    );
  }
  const cardLeft = left + inset;
  // TOP-aligned: a real holder grips the card snug under the label rail, with
  // the spare recess space at the BOTTOM. Verified against a high-res eBay
  // sale photo of the identical PSA-10 slab (docs/research/real-slab-ebay-1.jpg,
  // sourced via the card's own PriceCharting sales table): gap label→card
  // ≈ 0.07 of slab height, card top ≈ 0.25. A bottom-anchored variant (from
  // the low-res 380px PSA cert photo — a misleading reference) was rejected.
  const photo = await sharp(cleaned).resize(cardW, cardH).png().toBuffer();
  // No recess plate (operator, 2026-07-18): the card is composited straight
  // onto the transparent canvas, then the frame on top. The thin gap around the
  // card and its four die-cut corner cutouts stay TRANSPARENT — they take the
  // page colour on any background instead of a grey fill. Earlier builds painted
  // a grey "shadowed recess" here (rgb(148,148,153)) plus brighter case-tone
  // corner patches; the operator rejected both — the recess read as a grey edge
  // around the crop and the square patches read as sharp corners on the dark
  // storefront. Only the frame webp's own thin frosted case border frames the
  // card now.
  const layers: sharp.OverlayOptions[] = [
    { input: photo, left: cardLeft, top: cardTop },
    { input: frame, left: 0, top: 0 },
  ];
  if (label) {
    ensureLabelFont(); // must precede the first text render in this process
    layers.push({ input: renderLabelSvg(label, fw, fh), left: 0, top: 0 });
  }
  return sharp({
    create: {
      width: fw,
      height: fh,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite(layers)
    .webp({ quality: 90, alphaQuality: 90 })
    .toBuffer();
}

export type SlabCardInput = {
  handle: string;
  image: string;
  grader: string;
  grade: string;
  name: string; // raw card/product name — may embed "#238" (PC convention)
  set: string; // PriceCharting console-name, e.g. "Pokemon Surging Sparks"
  label_year?: string | null;
  label_note?: string | null;
};

// Bake one card. Best-effort by contract: ANY failure logs a warning and
// returns null — a bake must never fail a card save (spec §B.5). PSA-only
// (§9): the frame is PSA-branded, so any other grader (or a raw card) skips
// the bake and renders the bare photo via the existing null path.
export async function bakeSlabImage(
  container: MedusaContainer,
  card: SlabCardInput,
  frameBytes?: Buffer,
): Promise<BakedSlab | null> {
  if (card.grader.trim() !== 'PSA') return null;
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
    const out = await composeSlab(frame, photo, {
      set: card.set,
      name: card.name,
      grade: card.grade,
      year: card.label_year ?? null,
      note: card.label_note ?? null,
    });
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

// A card (graded or raw) still holding a baked composite — the thing the §9
// clear branch reclaims. Shared with repull-pc-images so the two paths'
// orphan handling can't diverge.
export const hasSlabRemnant = (card: {
  slab_image?: string | null;
  slab_image_key?: string | null;
}): boolean => Boolean(card.slab_image || card.slab_image_key);

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
    // Graded cards bake (or clear, for non-PSA). A RAW card can still hold an
    // orphaned composite from a since-cleared grader — include it so the §9
    // clear branch below reclaims it too.
    (c) => c.grader.trim() !== '' || hasSlabRemnant(c),
  );
  let ok = 0;
  let failed = 0;
  if (cards.length === 0) return { ok, failed };
  // Resolve the frame ONCE for the whole loop (reviewer finding): re-resolving
  // per card meant a mid-loop frame-fetch failure silently baked the
  // remaining cards against the bundled default while still counting them ok.
  const frameBytes = await resolveFrameBytes(container);
  for (const card of cards) {
    if (card.grader.trim() !== 'PSA') {
      // §9: non-PSA graders (and raw cards) never bake — and a composite left
      // over from the old frame-everything-as-PSA behaviour (or a cleared
      // grader) is a stale GEM MINT 10 lie. Clear it so the card renders its
      // bare photo.
      if (card.slab_image || card.slab_image_key) {
        try {
          const oldKey = card.slab_image_key ?? null;
          await packs.updateCards([
            { id: card.id, slab_image: null, slab_image_key: null },
          ]);
          await mirrorSlabToProduct(container, card.handle, null);
          await deleteSlabFile(container, oldKey);
          logger.info(
            `bake-slab: cleared non-PSA composite for ${card.handle}`,
          );
        } catch (e) {
          logger.warn(
            `bake-slab: failed to clear stale composite for '${card.handle}': ${e instanceof Error ? e.message : String(e)}`,
          );
          failed++;
          continue;
        }
      }
      ok++;
      continue;
    }
    const baked = await bakeSlabImage(
      container,
      {
        handle: card.handle,
        image: card.image,
        grader: card.grader,
        grade: card.grade,
        name: card.name,
        set: card.set,
        label_year: card.label_year ?? null,
        label_note: card.label_note ?? null,
      },
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

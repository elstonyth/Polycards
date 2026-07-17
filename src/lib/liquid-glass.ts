/**
 * Apple-style liquid glass refraction for any element — TS port of the
 * vendored module from the `liquid-glass` skill
 * (https://github.com/deepika-builds/liquid-glass, MIT). Client-only: call
 * from an effect, `destroy()` on unmount.
 *
 * The module owns the SVG filter, displacement map, backdrop-filter wiring,
 * resize handling, and the frosted-blur fallback for browsers that can't do
 * SVG-filtered backdrops (Safari, Firefox). Visual dressing (tint, inner
 * highlight, shadows) stays in the caller's CSS.
 */

export interface LiquidGlassOptions {
  /** Displacement strength (negative = magnifying bulge). Default -112. */
  scale?: number;
  /** Per-channel scale stagger; 0 disables the prism fringe. Default 6. */
  chroma?: number;
  /** Neutral interior inset as a fraction of the smaller side. Default 0.07. */
  border?: number;
  /** Edge-curvature softness (px) of the map's gray inset. Default 12. */
  mapBlur?: number;
  /** Backdrop blur (px) behind the glass interior. Default 3. */
  blur?: number;
  /** Backdrop saturation boost. Default 1.5. */
  saturate?: number;
  /** Corner radius override (px); default reads the element's border-radius. */
  radius?: number | null;
  /** Frosted blur (px) where refraction is unsupported. Default 16. */
  fallbackBlur?: number;
}

export interface LiquidGlassHandle {
  supported: boolean;
  refresh: () => void;
  destroy: () => void;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
let uid = 0;
let svgDefs: SVGDefsElement | null = null;
let supportedCache: boolean | null = null;

// Chromium can apply SVG filters via backdrop-filter; Safari and Firefox
// silently no-op, so they get the frosted fallback instead. Lazy so the
// module is import-safe during SSR.
function isSupported(): boolean {
  if (supportedCache !== null) return supportedCache;
  const ua = navigator.userAgent;
  const isSafari = /Safari/.test(ua) && !/Chrome|Chromium|Edg/.test(ua);
  const isFirefox = /Firefox/.test(ua);
  if (isSafari || isFirefox || !CSS.supports('backdrop-filter', 'url(#lg)')) {
    supportedCache = false;
    return false;
  }
  try {
    const c = document.createElement('canvas');
    c.width = c.height = 4;
    const ctx = c.getContext('2d');
    // A null 2D context (e.g. canvas blocked, too many contexts) means
    // makeMap() can't build a displacement map — that's "unsupported", not
    // "supported with an empty map".
    if (!ctx) {
      supportedCache = false;
      return false;
    }
    ctx.getImageData(0, 0, 1, 1);
    supportedCache = true;
  } catch {
    supportedCache = false;
  }
  return supportedCache;
}

function ensureDefs(): SVGDefsElement {
  if (svgDefs) return svgDefs;
  const svg = document.createElementNS(SVG_NS, 'svg');
  // width/height 0 keeps it renderable (display:none would break feImage)
  svg.setAttribute('width', '0');
  svg.setAttribute('height', '0');
  svg.setAttribute('aria-hidden', 'true');
  svg.style.position = 'absolute';
  svgDefs = document.createElementNS(SVG_NS, 'defs');
  svg.appendChild(svgDefs);
  document.body.appendChild(svg);
  return svgDefs;
}

// Displacement map, gradient-difference method: a red left->right ramp
// encodes X displacement, a blue top->bottom ramp encodes Y ("difference"
// keeps both since the channels are disjoint). A blurred, inset 50%-gray
// rounded rect neutralizes the interior, confining the refraction bulge to
// an edge band whose curvature is set by the blur radius.
function makeMap(
  w: number,
  h: number,
  radius: number,
  border: number,
  mapBlur: number,
): string {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';

  const gx = ctx.createLinearGradient(0, 0, w, 0);
  gx.addColorStop(0, 'rgb(0,0,0)');
  gx.addColorStop(1, 'rgb(255,0,0)');
  ctx.fillStyle = gx;
  ctx.fillRect(0, 0, w, h);

  const gy = ctx.createLinearGradient(0, 0, 0, h);
  gy.addColorStop(0, 'rgb(0,0,0)');
  gy.addColorStop(1, 'rgb(0,0,255)');
  ctx.globalCompositeOperation = 'difference';
  ctx.fillStyle = gy;
  ctx.fillRect(0, 0, w, h);

  ctx.globalCompositeOperation = 'source-over';
  const inset = border * Math.min(w, h);
  ctx.filter = `blur(${mapBlur}px)`;
  ctx.fillStyle = 'rgba(128,128,128,0.93)';
  ctx.beginPath();
  ctx.roundRect(
    inset,
    inset,
    w - inset * 2,
    h - inset * 2,
    Math.max(radius - inset, 2),
  );
  ctx.fill();
  ctx.filter = 'none';
  return canvas.toDataURL();
}

// Three displacement passes at staggered scales (R strongest), channels
// isolated with feColorMatrix and recombined with screen blends — the
// faint prism fringe at the rim.
function buildFilter(
  id: string,
  scales: [number, number, number],
): { filter: SVGFilterElement; feImage: SVGFEImageElement } {
  const filter = document.createElementNS(SVG_NS, 'filter');
  filter.setAttribute('id', id);
  filter.setAttribute('x', '0');
  filter.setAttribute('y', '0');
  filter.setAttribute('width', '100%');
  filter.setAttribute('height', '100%');
  // Load-bearing: filters default to linearRGB, which re-maps the map's
  // neutral gray 128 to ~0.216 and injects a constant phantom displacement.
  filter.setAttribute('color-interpolation-filters', 'sRGB');

  const feImage = document.createElementNS(SVG_NS, 'feImage');
  feImage.setAttribute('x', '0');
  feImage.setAttribute('y', '0');
  feImage.setAttribute('result', 'map');
  feImage.setAttribute('preserveAspectRatio', 'none');
  filter.appendChild(feImage);

  const keep: readonly string[] = [
    '1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0',
    '0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0',
    '0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0',
  ];
  keep.forEach((values, i) => {
    const disp = document.createElementNS(SVG_NS, 'feDisplacementMap');
    disp.setAttribute('in', 'SourceGraphic');
    disp.setAttribute('in2', 'map');
    disp.setAttribute('scale', String(scales[i]));
    disp.setAttribute('xChannelSelector', 'R');
    disp.setAttribute('yChannelSelector', 'B');
    disp.setAttribute('result', `d${i}`);
    filter.appendChild(disp);

    const cm = document.createElementNS(SVG_NS, 'feColorMatrix');
    cm.setAttribute('in', `d${i}`);
    cm.setAttribute('type', 'matrix');
    cm.setAttribute('values', values);
    cm.setAttribute('result', `c${i}`);
    filter.appendChild(cm);
  });

  const blend1 = document.createElementNS(SVG_NS, 'feBlend');
  blend1.setAttribute('in', 'c0');
  blend1.setAttribute('in2', 'c1');
  blend1.setAttribute('mode', 'screen');
  blend1.setAttribute('result', 'c01');
  filter.appendChild(blend1);

  const blend2 = document.createElementNS(SVG_NS, 'feBlend');
  blend2.setAttribute('in', 'c01');
  blend2.setAttribute('in2', 'c2');
  blend2.setAttribute('mode', 'screen');
  filter.appendChild(blend2);

  ensureDefs().appendChild(filter);
  return { filter, feImage };
}

function resolveRadius(
  el: HTMLElement,
  w: number,
  h: number,
  override: number | null,
): number {
  if (override != null) return override;
  const raw = getComputedStyle(el).borderTopLeftRadius || '0px';
  const v = parseFloat(raw) || 0;
  return raw.trim().endsWith('%') ? (v / 100) * Math.min(w, h) : v;
}

/** Apply liquid glass to an element. */
export function liquidGlass(
  el: HTMLElement,
  opts?: LiquidGlassOptions,
): LiquidGlassHandle {
  const o = {
    scale: -112,
    chroma: 6,
    border: 0.07,
    mapBlur: 12,
    blur: 3,
    saturate: 1.5,
    radius: null,
    fallbackBlur: 16,
    ...opts,
  };

  // Teardown restores whatever the caller had, rather than blanking it —
  // a pre-existing inline backdrop-filter or lg-fallback class isn't ours
  // to erase.
  const prevBackdrop = el.style.backdropFilter;

  if (!isSupported()) {
    const hadFallbackClass = el.classList.contains('lg-fallback');
    const frosted = `blur(${o.fallbackBlur}px) saturate(${o.saturate})`;
    el.style.backdropFilter = frosted;
    el.classList.add('lg-fallback');
    return {
      supported: false,
      refresh: () => {},
      destroy: () => {
        el.style.backdropFilter = prevBackdrop;
        if (!hadFallbackClass) el.classList.remove('lg-fallback');
      },
    };
  }

  const id = `lg-filter-${++uid}`;
  const scales: [number, number, number] = [
    o.scale,
    o.scale + o.chroma,
    o.scale + 2 * o.chroma,
  ];
  const parts = buildFilter(id, scales);

  function refresh(): void {
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    if (!w || !h) return;
    const radius = resolveRadius(el, w, h, o.radius);
    parts.feImage.setAttribute(
      'href',
      makeMap(w, h, radius, o.border, o.mapBlur),
    );
    parts.feImage.setAttribute('width', String(w));
    parts.feImage.setAttribute('height', String(h));
  }

  refresh();
  el.style.backdropFilter = `url(#${id}) blur(${o.blur}px) saturate(${o.saturate})`;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const ro = new ResizeObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(refresh, 120);
  });
  ro.observe(el);

  return {
    supported: true,
    refresh,
    destroy: () => {
      ro.disconnect();
      clearTimeout(timer);
      parts.filter.remove();
      el.style.backdropFilter = prevBackdrop;
    },
  };
}

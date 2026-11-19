// The live print on a pack's back: the pack-specific details (price, product
// line, pull odds, buyback wording) laid out and drawn over a "plate", the
// approved back art with those zones blanked (scripts/pack-back/make-plate.cjs).
// Everything else on the back (the fixed wording, the logo, the foil) stays the
// generated image, pixel for pixel. No React and no app imports, so the capture
// harness can load it as it is.
//
//   const layout = layoutPackPrint(details, PACK_151_PRINT, plateW, plateH, measureWith(ctx));
//   drawPackPrint(ctx, plate, layout);
//
// Text space: the print reads bottom to top, so layout works in a frame turned
// a quarter turn clockwise from the texture: u runs along a line (texture
// bottom to top), v runs down the stack of lines (texture left to right).
// Texture x = v, texture y = height - u.

/** What the back states about one pack. See pack-back-details.ts for where
 *  each field comes from on the pack page. */
export type PackBackDetails = {
  /** The price as the pack page prints it ("RM 40.00"); null prints none. */
  price: string | null;
  /** The pack's name, then its header facts ("151", "Pokémon", ...). */
  productLine: string[];
  /** Published odds rows, rarest first; null when the pack publishes none. */
  odds: { label: string; chance: string }[] | null;
  /** The buyback wording; null when the page shows none (free, ticket packs). */
  buyback: { headline: string; rule: string } | null;
};

/** A rectangle in fractions of the texture's width (x) and height (y). */
export type PrintRect = { x0: number; x1: number; y0: number; y1: number };

/** A face, size and tracking, in px of the spec's reference texture. */
export type PrintFont = {
  /** Key into DrawOptions.fonts / the measure's family map. */
  family: 'sans';
  weight: number;
  size: number;
  /** Extra advance after every character, px. */
  tracking: number;
  /** Extra advance after every space, px (on top of tracking). */
  wordSpacing?: number;
};

/**
 * Where and how one pack's back prints its details. Positions are text-space
 * px at the reference texture size (`image`); they scale with the texture.
 */
export type PackPrintSpec = {
  image: { width: number; height: number };
  orientation: 'bottom-to-top';
  /** The plate's blanked zones (texture fractions), as in the pack's geometry
   *  JSON. Runs never leave the zone they belong to. */
  zones: {
    headline: PrintRect;
    odds: PrintRect;
    buyback: PrintRect;
  };
  /** Printed ink: colour and the softness of the print (gaussian sigma, px). */
  ink: { color: string; softness: number };
  /** Space kept clear inside a zone's long edge (u) when fitting, px. */
  inset: number;
  price: {
    font: PrintFont;
    x: number;
    baseline: number;
    /** A price is never cut or wrapped: one wider than its room shrinks to
     *  fit whatever it takes, and below this scale the layout's fit report
     *  flags it (belowMin). Absent = no floor to report against. */
    minScale?: number;
  };
  productLine: {
    font: PrintFont;
    x: number;
    baseline: number;
    separator: string;
    minScale: number;
  };
  odds: {
    font: PrintFont;
    firstBaseline: number;
    pitch: number;
    /** The lowest baseline the rows may use. */
    lastBaseline: number;
    /** Each column: label start and the value's right edge (values align right). */
    columns: { labelX: number; valueRight: number }[];
    /** Tracking of the chances, when it differs from the labels' (px). */
    valueTracking?: number;
    minScale: number;
  };
  buyback: {
    font: PrintFont;
    x: number;
    firstBaseline: number;
    pitch: number;
    lastBaseline: number;
    maxWidth: number;
    minScale: number;
  };
};

export type PrintRole =
  'price' | 'productLine' | 'oddsLabel' | 'oddsValue' | 'buyback';

/** One positioned run of text, in text-space px of the actual texture. */
export type PrintRun = {
  role: PrintRole;
  text: string;
  font: PrintFont;
  /** Start of the run along the line (or its end, for align right). */
  x: number;
  /** Baseline, down the stack. */
  y: number;
  align: 'left' | 'right';
  /** Advance width, tracking included. */
  width: number;
};

export type PrintLayout = {
  width: number;
  height: number;
  orientation: 'bottom-to-top';
  runs: PrintRun[];
  /** Which plate the runs go over: 'no-odds' also blanks the odds heading. */
  plate: 'live' | 'no-odds';
  /** Zones in text space (u along, v down), for checks and the draw bounds. */
  zones: Record<keyof PackPrintSpec['zones'], TextRect>;
  ink: PackPrintSpec['ink'];
  /** How each field fitted: scale against the spec's size (1 = full size). */
  fit?: PrintFit;
};

/** What the layout had to do to make each field fit its zone. */
export type PrintFit = {
  price?: { scale: number; belowMin: boolean };
  /** `dropped`: trailing facts left off (a wording change: treat as a fault). */
  productLine?: { scale: number; dropped: string[] };
  odds?: { scale: number };
  /** `overflow`: the last line sits past the lowest baseline even at minScale. */
  buyback?: { scale: number; lines: number; overflow: boolean };
};

/** A rectangle in text space: u along the lines, v down the stack. */
export type TextRect = { u0: number; u1: number; v0: number; v1: number };

/** Advance width of `text` in `font` at `font.size`, tracking NOT included. */
export type MeasureText = (text: string, font: PrintFont) => number;

/** A texture-fraction rectangle in text space for a width x height texture. */
export function zoneInTextSpace(
  rect: PrintRect,
  width: number,
  height: number,
): TextRect {
  return {
    u0: height * (1 - rect.y1),
    u1: height * (1 - rect.y0),
    v0: width * rect.x0,
    v1: width * rect.x1,
  };
}

/** Text space to texture px (bottom-to-top print). */
export function textToTexture(
  height: number,
  u: number,
  v: number,
): { x: number; y: number } {
  return { x: v, y: height - u };
}

const glyphs = (text: string) => Array.from(text);

/** Advance width with tracking, as drawPackPrint lays the glyphs. */
export function runWidth(
  text: string,
  font: PrintFont,
  measure: MeasureText,
): number {
  const chars = glyphs(text);
  return measure(text, font) + glyphOffset(chars, chars.length - 1, font);
}

/** Tracking and word spacing before glyph `i` (0 for the first). */
function glyphOffset(chars: string[], i: number, font: PrintFont): number {
  let spaces = 0;
  for (let j = 0; j < i; j++) if (chars[j] === ' ') spaces++;
  return Math.max(0, i) * font.tracking + spaces * (font.wordSpacing ?? 0);
}

const scaleFont = (font: PrintFont, k: number): PrintFont => ({
  ...font,
  size: font.size * k,
  tracking: font.tracking * k,
  wordSpacing: (font.wordSpacing ?? 0) * k,
});

/** Greedy word wrap; a word longer than the line stays whole on its own line. */
function wrap(
  text: string,
  font: PrintFont,
  maxWidth: number,
  measure: MeasureText,
): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (line && runWidth(next, font, measure) > maxWidth) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

/** The headline and rule as one paragraph: "90% instant buyback. The pack…". */
export function buybackParagraph(buyback: {
  headline: string;
  rule: string;
}): string {
  const head = buyback.headline.trim();
  const end = /[.!?]$/.test(head) ? '' : '.';
  return `${head}${end} ${buyback.rule.trim()}`.trim();
}

/**
 * Pure layout: the details placed in the spec's zones for a width x height
 * texture. Text too long for its zone is set smaller (down to the spec's
 * minScale); a product line still too long loses its trailing facts. Odds
 * fill two columns, column by column; more rows than the box holds tighten the
 * row pitch and the type together.
 */
export function layoutPackPrint(
  details: PackBackDetails,
  spec: PackPrintSpec,
  width: number,
  height: number,
  measure: MeasureText,
): PrintLayout {
  const k = height / spec.image.height;
  const kv = width / spec.image.width;
  const zones = {
    headline: zoneInTextSpace(spec.zones.headline, width, height),
    odds: zoneInTextSpace(spec.zones.odds, width, height),
    buyback: zoneInTextSpace(spec.zones.buyback, width, height),
  };
  const inset = spec.inset * k;
  const runs: PrintRun[] = [];
  const push = (
    role: PrintRole,
    text: string,
    font: PrintFont,
    x: number,
    y: number,
    align: 'left' | 'right' = 'left',
  ) =>
    runs.push({
      role,
      text,
      font,
      x,
      y,
      align,
      width: runWidth(text, font, measure),
    });

  const fit: PrintFit = {};

  // --- price and product line (headline zone) ---------------------------------
  const lineEnd = zones.headline.u1 - inset;
  if (details.price) {
    const x = spec.price.x * k;
    let font = scaleFont(spec.price.font, k);
    const w = runWidth(details.price, font, measure);
    let scale = 1;
    if (w > lineEnd - x) {
      scale = (lineEnd - x) / w;
      font = scaleFont(font, scale);
    }
    fit.price = { scale, belowMin: scale < (spec.price.minScale ?? 0) };
    push('price', details.price, font, x, spec.price.baseline * kv);
  }
  const parts = details.productLine.map((p) => p.trim()).filter(Boolean);
  if (parts.length > 0) {
    const s = spec.productLine;
    const x = s.x * k;
    const room = lineEnd - x;
    const base = scaleFont(s.font, k);
    let shown = parts;
    let font = base;
    for (;;) {
      const text = shown.join(s.separator);
      const w = runWidth(text, base, measure);
      if (w <= room) {
        font = base;
        break;
      }
      if (room / w >= s.minScale || shown.length === 1) {
        font = scaleFont(base, Math.max(s.minScale, room / w));
        break;
      }
      shown = shown.slice(0, -1);
    }
    // the one-part case may still overflow at minScale: set it to fit outright
    const text = shown.join(s.separator);
    const w = runWidth(text, font, measure);
    if (w > room) font = scaleFont(font, room / w);
    fit.productLine = {
      scale: font.size / base.size,
      dropped: parts.slice(shown.length),
    };
    push('productLine', text, font, x, s.baseline * kv);
  }

  // --- odds (odds zone) ----------------------------------------------------------
  const odds = details.odds && details.odds.length > 0 ? details.odds : null;
  if (odds) {
    const s = spec.odds;
    const cols = s.columns.length;
    const perCol = Math.ceil(odds.length / cols);
    const first = s.firstBaseline * kv;
    const last = s.lastBaseline * kv;
    let pitch = s.pitch * kv;
    let scale = 1;
    if (perCol > 1 && first + (perCol - 1) * pitch > last) {
      scale = Math.max(s.minScale, (last - first) / ((perCol - 1) * pitch));
      pitch *= scale;
    }
    let font = scaleFont(s.font, k * scale);
    const valueFont = (f: PrintFont): PrintFont => ({
      ...f,
      tracking: (s.valueTracking ?? s.font.tracking) * (f.size / s.font.size),
    });
    // every label and value must fit its column
    const gap = font.size * 0.5;
    for (let i = 0; i < odds.length; i++) {
      const c = s.columns[Math.floor(i / perCol)];
      if (!c) continue;
      const row = odds[i];
      if (!row) continue;
      const need =
        runWidth(row.label, font, measure) +
        gap +
        runWidth(row.chance, valueFont(font), measure);
      const room = (c.valueRight - c.labelX) * k;
      if (need > room) font = scaleFont(font, room / need);
    }
    fit.odds = { scale: font.size / (s.font.size * k) };
    odds.forEach((row, i) => {
      const c = s.columns[Math.floor(i / perCol)];
      if (!c) return;
      const y = first + (i % perCol) * pitch;
      push('oddsLabel', row.label, font, c.labelX * k, y);
      push(
        'oddsValue',
        row.chance,
        valueFont(font),
        c.valueRight * k,
        y,
        'right',
      );
    });
  }

  // --- buyback paragraph (buyback zone) ------------------------------------------
  if (details.buyback) {
    const s = spec.buyback;
    const text = buybackParagraph(details.buyback);
    const x = s.x * k;
    const maxWidth = Math.min(s.maxWidth * k, zones.buyback.u1 - inset - x);
    const first = s.firstBaseline * kv;
    const last = s.lastBaseline * kv;
    let scale = 1;
    let lines = wrap(text, scaleFont(s.font, k), maxWidth, measure);
    while (
      lines.length > 1 &&
      first + (lines.length - 1) * s.pitch * kv * scale > last &&
      scale > s.minScale
    ) {
      scale = Math.max(s.minScale, scale - 0.025);
      lines = wrap(text, scaleFont(s.font, k * scale), maxWidth, measure);
    }
    const font = scaleFont(s.font, k * scale);
    lines.forEach((line, i) =>
      push('buyback', line, font, x, first + i * s.pitch * kv * scale),
    );
    fit.buyback = {
      scale,
      lines: lines.length,
      overflow:
        lines.length > 1 &&
        first + (lines.length - 1) * s.pitch * kv * scale > last + 1e-9,
    };
  }

  return {
    width,
    height,
    orientation: spec.orientation,
    runs,
    plate: odds ? 'live' : 'no-odds',
    zones,
    // softness in this texture's px
    ink: { color: spec.ink.color, softness: spec.ink.softness * k },
    fit,
  };
}

// --- drawing ---------------------------------------------------------------------

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;

export type DrawOptions = {
  /** CSS font-family lists for the spec's family keys (default Geist). In the
   *  app, the family next/font registered (e.g. from --font-geist-sans). */
  fonts?: Partial<Record<PrintFont['family'], string>>;
  /** A scratch canvas factory (default OffscreenCanvas, else a DOM canvas). */
  createCanvas?: (width: number, height: number) => AnyCanvas;
};

const DEFAULT_FONTS: Record<PrintFont['family'], string> = {
  sans: 'Geist, sans-serif',
};

/** The canvas font shorthand for a run's font. */
export function cssFont(
  font: PrintFont,
  fonts: DrawOptions['fonts'] = {},
): string {
  const family = fonts[font.family] ?? DEFAULT_FONTS[font.family];
  return `${Math.round(font.weight)} ${font.size.toFixed(2)}px ${family}`;
}

/** A MeasureText backed by a canvas context (the same fonts the draw uses). */
export function measureWith(
  ctx: Ctx2D,
  fonts: DrawOptions['fonts'] = {},
): MeasureText {
  return (text, font) => {
    ctx.font = cssFont(font, fonts);
    return ctx.measureText(text).width;
  };
}

function scratch(
  width: number,
  height: number,
  options: DrawOptions,
): AnyCanvas {
  if (options.createCanvas) return options.createCanvas(width, height);
  if (typeof OffscreenCanvas !== 'undefined')
    return new OffscreenCanvas(width, height);
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  return c;
}

function parseColor(color: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(color.trim());
  if (!m || !m[1]) return [255, 255, 255];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Separable gaussian blur of a coverage buffer, in place. */
function blurCoverage(
  a: Float32Array,
  w: number,
  h: number,
  sigma: number,
): void {
  if (sigma < 0.05) return;
  const r = Math.max(1, Math.ceil(sigma * 3));
  const kernel = new Float32Array(2 * r + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++)
    sum += kernel[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma));
  for (let i = 0; i < kernel.length; i++) kernel[i] = (kernel[i] ?? 0) / sum;
  const t = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let i = -r; i <= r; i++) {
        const xx = Math.min(w - 1, Math.max(0, x + i));
        v += (a[y * w + xx] ?? 0) * (kernel[i + r] ?? 0);
      }
      t[y * w + x] = v;
    }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let i = -r; i <= r; i++) {
        const yy = Math.min(h - 1, Math.max(0, y + i));
        v += (t[yy * w + x] ?? 0) * (kernel[i + r] ?? 0);
      }
      a[y * w + x] = v;
    }
}

/**
 * Draws the plate and the layout's runs onto `ctx` (a canvas the size of the
 * layout). The ink is laid as printed ink is: its coverage softened by the
 * spec's softness, then mixed over the foil in the zone. Alpha is never
 * touched, so the pack's outline stays the plate's.
 */
export function drawPackPrint(
  ctx: Ctx2D,
  plate: CanvasImageSource,
  layout: PrintLayout,
  options: DrawOptions = {},
): void {
  const { width: W, height: H } = layout;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'copy';
  ctx.drawImage(plate, 0, 0, W, H);
  ctx.restore();
  if (layout.runs.length === 0) return;

  // Draw bounds: the zones the runs belong to, in texture px, padded for the blur.
  const pad = Math.ceil(layout.ink.softness * 3) + 2;
  let bx0 = W,
    by0 = H,
    bx1 = 0,
    by1 = 0;
  for (const z of Object.values(layout.zones)) {
    bx0 = Math.min(bx0, z.v0);
    bx1 = Math.max(bx1, z.v1);
    by0 = Math.min(by0, H - z.u1);
    by1 = Math.max(by1, H - z.u0);
  }
  bx0 = Math.max(0, Math.floor(bx0) - pad);
  by0 = Math.max(0, Math.floor(by0) - pad);
  bx1 = Math.min(W, Math.ceil(bx1) + pad);
  by1 = Math.min(H, Math.ceil(by1) + pad);
  const bw = bx1 - bx0,
    bh = by1 - by0;
  if (bw <= 0 || bh <= 0) return;

  // 1. coverage: the runs in white on a clear scratch canvas
  const layer = scratch(bw, bh, options);
  const g = layer.getContext('2d') as Ctx2D | null;
  if (!g) throw new Error('drawPackPrint: no 2d context for the text layer');
  g.clearRect(0, 0, bw, bh);
  // texture = translate(0, H) . rotate(-90deg) . text space, shifted to the layer
  g.setTransform(0, -1, 1, 0, -bx0, H - by0);
  g.fillStyle = '#ffffff';
  g.textBaseline = 'alphabetic';
  g.textAlign = 'left';
  for (const run of layout.runs) {
    g.font = cssFont(run.font, options.fonts);
    const start = run.align === 'right' ? run.x - run.width : run.x;
    if (run.font.tracking === 0 && !run.font.wordSpacing) {
      g.fillText(run.text, start, run.y);
      continue;
    }
    // tracking by hand (ctx.letterSpacing is not everywhere): each glyph at the
    // advance of everything before it, so kerning inside the run still holds
    const chars = glyphs(run.text);
    let prefix = '';
    chars.forEach((ch, i) => {
      const at =
        start + g.measureText(prefix).width + glyphOffset(chars, i, run.font);
      g.fillText(ch, at, run.y);
      prefix += ch;
    });
  }
  const cov = g.getImageData(0, 0, bw, bh).data;
  const a = new Float32Array(bw * bh);
  for (let i = 0; i < bw * bh; i++) a[i] = (cov[i * 4 + 3] ?? 0) / 255;

  // 2. the softness of printed ink
  blurCoverage(a, bw, bh, layout.ink.softness);

  // 3. ink over the foil, alpha untouched
  const [ir, ig, ib] = parseColor(layout.ink.color);
  const img = ctx.getImageData(bx0, by0, bw, bh);
  const d = img.data;
  for (let i = 0; i < bw * bh; i++) {
    const t = Math.min(1, a[i] ?? 0);
    if (t <= 0.0005) continue;
    const p = i * 4;
    d[p] = (d[p] ?? 0) + (ir - (d[p] ?? 0)) * t;
    d[p + 1] = (d[p + 1] ?? 0) + (ig - (d[p + 1] ?? 0)) * t;
    d[p + 2] = (d[p + 2] ?? 0) + (ib - (d[p + 2] ?? 0)) * t;
  }
  ctx.putImageData(img, bx0, by0);
}

type PlateImage = CanvasImageSource & { width: number; height: number };

/** The two plates make-plate.cjs writes: `live` (the standard one) and
 *  `noOdds` (also without the fixed odds heading, for a pack with no odds). */
export type PackPlates = { live: PlateImage; noOdds: PlateImage };

/**
 * Plates in, finished back texture out: lays out `details` with the canvas's
 * own font metrics and draws them over the plate the layout asks for. Wait
 * for the fonts first (document.fonts).
 */
export function renderPackBack(
  plates: PackPlates,
  details: PackBackDetails,
  spec: PackPrintSpec,
  options: DrawOptions = {},
): { canvas: AnyCanvas; layout: PrintLayout } {
  const W = plates.live.width,
    H = plates.live.height;
  const canvas = scratch(W, H, options);
  const ctx = canvas.getContext('2d') as Ctx2D | null;
  if (!ctx) throw new Error('renderPackBack: no 2d context');
  const layout = layoutPackPrint(
    details,
    spec,
    W,
    H,
    measureWith(ctx, options.fonts),
  );
  drawPackPrint(
    ctx,
    layout.plate === 'no-odds' ? plates.noOdds : plates.live,
    layout,
    options,
  );
  return { canvas, layout };
}

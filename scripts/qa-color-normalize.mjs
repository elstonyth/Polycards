// Browser-side shim for the axe scans.
//
// Tailwind v4 ships its palette as oklch(). CSS Color 4 makes hue POWERLESS at
// zero chroma, so Chrome serializes every neutral as `oklch(0.145 0 none)` —
// and axe-core 4.12.1 (latest as of 2026-07-21) cannot parse `none`, so it
// aborts the whole color-contrast rule and reports zero passes AND zero
// violations. A rule that never ran reads as green, which is how a broken gate
// hides real failures.
//
// Fix: before scanning, resolve every computed color through a canvas (which
// paints the real sRGB pixel regardless of how the value serializes) and pin it
// back as an inline rgb()/rgba(). axe then sees values it can parse. Purely a
// scan-time transform — nothing ships this to users.
export function installColorNormalizer() {
  window.__qaNormalizeColors = () => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const cache = new Map();

    // Paint the colour and read the pixel back: the only conversion that works
    // for every colour syntax the browser accepts, including `none` components.
    const toRgb = (value) => {
      if (!value || value === 'transparent') return null;
      if (value.startsWith('rgb(') || value.startsWith('rgba(')) return null;
      if (cache.has(value)) return cache.get(value);
      let out = null;
      try {
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = '#000';
        ctx.fillStyle = value;
        // An unparseable value leaves fillStyle at the previous colour; that is
        // fine — we only need SOME parseable rgb for axe, and a wrong-but-parseable
        // value would be worse, so bail when the assignment clearly did not take.
        if (
          ctx.fillStyle === '#000000' &&
          !/^(#000000|black|rgb\(0, ?0, ?0\))$/i.test(value)
        ) {
          cache.set(value, null);
          return null;
        }
        ctx.fillRect(0, 0, 1, 1);
        const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
        out =
          a === 255
            ? `rgb(${r}, ${g}, ${b})`
            : `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(3)})`;
      } catch {
        out = null;
      }
      cache.set(value, out);
      return out;
    };

    let changed = 0;
    for (const el of document.querySelectorAll('*')) {
      const cs = getComputedStyle(el);
      // Exactly the properties axe reads: `color` + `background-color` for
      // color-contrast, and `border-top-color` / `border-bottom-color` /
      // `outline-color` for link-in-text-block. The `border-color` shorthand is
      // NOT one of them, and getComputedStyle serializes it per-side anyway once
      // the sides differ (unparseable, so it silently normalized nothing).
      for (const prop of [
        'color',
        'backgroundColor',
        'borderTopColor',
        'borderBottomColor',
        'outlineColor',
      ]) {
        const rgb = toRgb(cs[prop]);
        if (rgb) {
          el.style[prop] = rgb;
          changed++;
        }
      }
    }
    return changed;
  };
}

installColorNormalizer();

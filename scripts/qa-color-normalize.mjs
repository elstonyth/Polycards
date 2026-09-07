// Browser-side color adapter used only by the axe scan. CSS Color 4 neutrals
// can serialize as `oklch(0.205 0 none)`, which axe cannot parse.
//
// Convert computed-color READS through canvas, preserving the rendered sRGB
// pixel and alpha. A one-time inline rewrite misses rows mounted by the live
// feed after normalization; it also pins stale colors across class changes.
// Reading through the native declaration covers late nodes and pseudo-elements
// without changing page styles or starting a mutation observer.
export function installColorNormalizer() {
  if (window.__qaNormalizeColors) return;
  window.__qaNormalizeColors = () => {
    const nativeGetComputedStyle = window.getComputedStyle.bind(window);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const cache = new Map();
    // Both CSSStyleDeclaration property access and getPropertyValue() are used
    // by axe. Its foreground calculation prefers WebKit text fill/stroke over
    // `color`, so those must be converted too (axe-core 4.13 getTextColor).
    const colorProperties = new Set([
      'color',
      'backgroundColor',
      'background-color',
      'borderTopColor',
      'border-top-color',
      'borderBottomColor',
      'border-bottom-color',
      'outlineColor',
      'outline-color',
      'webkitTextFillColor',
      '-webkit-text-fill-color',
      'webkitTextStrokeColor',
      '-webkit-text-stroke-color',
    ]);
    const toRgb = (value) => {
      if (!value || value === 'transparent') return value;
      if (value.startsWith('rgb(') || value.startsWith('rgba(')) return value;
      if (cache.has(value)) return cache.get(value);
      let out = value;
      try {
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = '#000';
        ctx.fillStyle = value;
        if (
          ctx.fillStyle === '#000000' &&
          !/^(#000000|black|rgb\(0, ?0, ?0\))$/i.test(value)
        )
          return value;
        ctx.fillRect(0, 0, 1, 1);
        const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
        out =
          a === 255
            ? `rgb(${r}, ${g}, ${b})`
            : `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(3)})`;
      } catch {
        /* Keep the original value so axe still fails on unsupported input. */
      }
      cache.set(value, out);
      return out;
    };
    window.getComputedStyle = (element, pseudoElement) => {
      const declaration = nativeGetComputedStyle(element, pseudoElement);
      return new Proxy(declaration, {
        get(target, property) {
          if (property === 'getPropertyValue')
            return (name) => {
              const value = target.getPropertyValue(name);
              return colorProperties.has(name) ? toRgb(value) : value;
            };
          // Native CSSStyleDeclaration getters/methods require the real
          // receiver. Unrelated properties, custom properties and methods keep
          // their native values and behavior.
          const value = Reflect.get(target, property, target);
          if (colorProperties.has(property)) return toRgb(value);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    };
    // Repeated preparation must not stack adapters in the same document.
    window.__qaNormalizeColors = () => {};
  };
}
installColorNormalizer();

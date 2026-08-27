import { describe, expect, it } from 'vitest';
import { resolveImageUrl } from './image-url';

// The scheme guard is the security-relevant half of this helper (CodeQL alert
// #2, js/xss-through-dom). Every current call site is an <img src>, where a
// javascript: URL does not execute in any current browser — so these cases pin
// intent, not a live exploit. They exist because the values reaching here come
// partly from a third-party API and from admin free-text, and the first call
// site to use an href would turn the intent into a requirement.
describe('resolveImageUrl scheme handling', () => {
  it('refuses a scheme that is not http(s) or an image data: URI', () => {
    for (const hostile of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      'vbscript:msgbox(1)',
      'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
      'file:///etc/passwd',
      // Spellings a browser normalises back to javascript: before dispatching.
      // The first three are leading-whitespace; the last three carry the control
      // character INSIDE the scheme, which a leading-only strip does not catch.
      '\tjavascript:alert(1)',
      ' javascript:alert(1)',
      '\u0000javascript:alert(1)',
      'java\tscript:alert(1)',
      'java\nscript:alert(1)',
      'java\rscript:alert(1)',
    ]) {
      expect(resolveImageUrl(hostile)).toBe('');
    }
  });

  it('refuses data: entirely, image subtypes included', () => {
    // data:image/* used to pass through verbatim. Nothing in admin or vendor
    // produces a data: URL, so the allowance only widened what a caller could
    // hand to the DOM unaltered. Re-adding it means re-adding an ordering
    // constraint: the scheme guard has to run first, or data:text/html rides in
    // behind it.
    expect(resolveImageUrl('data:text/html,<script>alert(1)</script>')).toBe(
      '',
    );
    expect(resolveImageUrl('data:image/png;base64,iVBORw0KGgo=')).toBe('');
    expect(resolveImageUrl('data:image/svg+xml,<svg onload=alert(1)>')).toBe(
      '',
    );
  });

  it('leaves the shapes the admin actually renders untouched', () => {
    // Remote CDN URLs pass through; relative paths get an origin prefixed.
    expect(resolveImageUrl('https://cdn.example.test/a.webp')).toBe(
      'https://cdn.example.test/a.webp',
    );
    expect(resolveImageUrl('/cdn/cards/x.webp')).toMatch(
      /\/cdn\/cards\/x\.webp$/,
    );
    // A bare relative filename has no scheme, so the guard must not eat it.
    expect(resolveImageUrl('x.webp')).toBe('x.webp');
    // Normalisation must not eat a legitimate URL, and a tab-prefixed relative
    // path still resolves against the storefront rather than being passed
    // through unprefixed.
    expect(resolveImageUrl('  https://cdn.example.test/a.webp')).toBe(
      'https://cdn.example.test/a.webp',
    );
    expect(resolveImageUrl('\t/cdn/cards/x.webp')).toMatch(
      /\/cdn\/cards\/x\.webp$/,
    );
    expect(resolveImageUrl('')).toBe('');
    expect(resolveImageUrl(null)).toBe('');
    expect(resolveImageUrl(undefined)).toBe('');
  });
});

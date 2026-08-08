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
    ]) {
      expect(resolveImageUrl(hostile)).toBe('');
    }
  });

  it('refuses data:text/html even though data: is otherwise allowed', () => {
    // Regression pin for the ordering: the guard sits ABOVE the data:
    // passthrough. Move it below and this is the case that goes green wrongly.
    expect(resolveImageUrl('data:text/html,<script>alert(1)</script>')).toBe(
      '',
    );
    expect(resolveImageUrl('data:image/png;base64,iVBORw0KGgo=')).toBe(
      'data:image/png;base64,iVBORw0KGgo=',
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
    expect(resolveImageUrl('')).toBe('');
    expect(resolveImageUrl(null)).toBe('');
    expect(resolveImageUrl(undefined)).toBe('');
  });
});

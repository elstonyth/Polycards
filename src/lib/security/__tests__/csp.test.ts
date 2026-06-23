import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildCsp } from '../csp';

describe('buildCsp', () => {
  let prevBackend: string | undefined;
  let prevMediaHost: string | undefined;

  beforeEach(() => {
    prevBackend = process.env.NEXT_PUBLIC_MEDUSA_BACKEND_URL;
    prevMediaHost = process.env.NEXT_PUBLIC_MEDIA_HOST;
    process.env.NEXT_PUBLIC_MEDUSA_BACKEND_URL = 'http://localhost:9000';
    delete process.env.NEXT_PUBLIC_MEDIA_HOST;
  });

  afterEach(() => {
    if (prevBackend === undefined)
      delete process.env.NEXT_PUBLIC_MEDUSA_BACKEND_URL;
    else process.env.NEXT_PUBLIC_MEDUSA_BACKEND_URL = prevBackend;
    if (prevMediaHost === undefined) delete process.env.NEXT_PUBLIC_MEDIA_HOST;
    else process.env.NEXT_PUBLIC_MEDIA_HOST = prevMediaHost;
  });

  // The policy is intentionally nonce-free: most pages are statically
  // prerendered, and Next cannot inject a per-request nonce at build time, so a
  // nonce + 'strict-dynamic' script-src is unenforceable site-wide (it blocks
  // every script on a static page). 'self' + 'unsafe-inline' is enforceable
  // everywhere and still blocks cross-origin script injection.
  it('allows same-origin and inline scripts without a nonce or strict-dynamic', () => {
    const csp = buildCsp();
    expect(csp).toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).not.toContain('strict-dynamic');
    expect(csp).not.toContain('nonce-');
  });

  it('allows the backend origin in connect-src and img-src', () => {
    const csp = buildCsp();
    expect(csp).toContain('http://localhost:9000');
    expect(csp).toMatch(/connect-src[^;]*http:\/\/localhost:9000/);
    expect(csp).toMatch(/img-src[^;]*http:\/\/localhost:9000/);
  });

  // The SDK (lib/medusa.ts) and the image optimizer (next.config.ts) both
  // default the backend to http://localhost:9000 when the env var is unset, so
  // the CSP must allow it too — otherwise an enforced policy blocks every backend
  // fetch/image in that default configuration.
  it('defaults the backend origin to localhost:9000 when the env var is unset', () => {
    delete process.env.NEXT_PUBLIC_MEDUSA_BACKEND_URL;
    const csp = buildCsp();
    expect(csp).toMatch(/connect-src[^;]*http:\/\/localhost:9000/);
    expect(csp).toMatch(/img-src[^;]*http:\/\/localhost:9000/);
  });

  it('includes the media CDN host when set', () => {
    process.env.NEXT_PUBLIC_MEDIA_HOST = 'cdn.example.com';
    const csp = buildCsp();
    expect(csp).toContain('https://cdn.example.com');
  });

  it('forbids framing and inline object/base hijacking', () => {
    const csp = buildCsp();
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
  });

  it('includes self in connect-src', () => {
    const csp = buildCsp();
    expect(csp).toMatch(/connect-src[^;]*'self'/);
  });
});

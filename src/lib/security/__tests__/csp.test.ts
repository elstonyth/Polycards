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

  it('pins scripts to the nonce with strict-dynamic', () => {
    const csp = buildCsp('abc123');
    expect(csp).toContain("script-src 'self' 'nonce-abc123' 'strict-dynamic'");
  });

  it('allows the backend origin in connect-src and img-src', () => {
    const csp = buildCsp('n');
    expect(csp).toContain('http://localhost:9000');
    expect(csp).toMatch(/connect-src[^;]*http:\/\/localhost:9000/);
    expect(csp).toMatch(/img-src[^;]*http:\/\/localhost:9000/);
  });

  it('includes the media CDN host when set', () => {
    process.env.NEXT_PUBLIC_MEDIA_HOST = 'cdn.example.com';
    const csp = buildCsp('n');
    expect(csp).toContain('https://cdn.example.com');
  });

  it('forbids framing and inline object/base hijacking', () => {
    const csp = buildCsp('n');
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
  });

  it('includes self in connect-src', () => {
    const csp = buildCsp('n');
    expect(csp).toMatch(/connect-src[^;]*'self'/);
  });
});

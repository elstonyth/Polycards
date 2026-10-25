import { describe, it, expect } from 'vitest';
import { isOptimizableImage } from '@/lib/optimizable-image';
import { mediaHost } from '@/lib/security/csp';

describe('isOptimizableImage', () => {
  it('optimizes local /public art and our own media host', () => {
    expect(isOptimizableImage('/images/polycards/bronze-pack.webp')).toBe(true);
    expect(
      isOptimizableImage(`https://${mediaHost()}/poncho-pack-01M4V5AQ.webp`),
    ).toBe(true);
  });

  it('leaves any other host (and protocol-relative URLs) unoptimized', () => {
    expect(isOptimizableImage('https://example.com/pack.webp')).toBe(false);
    expect(isOptimizableImage(`//${mediaHost()}/x.webp`)).toBe(false);
    expect(
      isOptimizableImage(`https://${mediaHost()}.evil.example/x.webp`),
    ).toBe(false);
    expect(isOptimizableImage('')).toBe(false);
  });
});

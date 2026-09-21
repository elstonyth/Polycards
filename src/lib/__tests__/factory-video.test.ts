import { afterEach, describe, it, expect, vi } from 'vitest';
import { factoryVideo } from '../packs-data';

describe('factoryVideo', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('resolves mp4/webm/poster for each baked tier', () => {
    for (const tier of [
      'bronze',
      'silver',
      'gold',
      'platinum',
      'diamond',
      'ascended',
      'celebration',
    ]) {
      expect(factoryVideo(`/images/polycards/${tier}-factory.webp`)).toEqual({
        mp4: `/images/polycards/${tier}-factory.mp4`,
        webm: `/images/polycards/${tier}-factory.webm`,
        poster: `/images/polycards/${tier}-factory-poster.webp`,
      });
    }
  });

  it('keeps a registered factory animated after uploading its still through admin', () => {
    vi.stubEnv('NEXT_PUBLIC_MEDIA_HOST', undefined);
    expect(
      factoryVideo(
        'https://polycards-media.sgp1.cdn.digitaloceanspaces.com/celebration-factory-01M32GC8049JJBNVKEP3VMYNC4.webp',
      ),
    ).toEqual(factoryVideo('/images/polycards/celebration-factory.webp'));
    for (const url of [
      'https://cdn.example.com/celebration-factory-01M32GC8049JJBNVKEP3VMYNC4.webp',
      'https://polycards-media.sgp1.cdn.digitaloceanspaces.com/custom-factory-01M32GC8049JJBNVKEP3VMYNC4.webp',
      'https://polycards-media.sgp1.cdn.digitaloceanspaces.com/custom-hero.webp',
    ]) {
      expect(factoryVideo(url)).toBeNull();
    }
  });

  it('uses the configured media host for uploaded factory scenes', () => {
    vi.stubEnv('NEXT_PUBLIC_MEDIA_HOST', 'media.example.com');
    expect(
      factoryVideo(
        'https://media.example.com/celebration-factory-01M32GC8049JJBNVKEP3VMYNC4.webp',
      ),
    ).toEqual(factoryVideo('/images/polycards/celebration-factory.webp'));
    expect(
      factoryVideo(
        'https://media.example.com.attacker.test/celebration-factory-01M32GC8049JJBNVKEP3VMYNC4.webp',
      ),
    ).toBeNull();
  });

  it('returns null for undefined / a pack shot / an arbitrary uploaded hero', () => {
    expect(factoryVideo(undefined)).toBeNull();
    // a pack shot, not a factory scene
    expect(factoryVideo('/images/polycards/gold-pack.webp')).toBeNull();
    // an uploaded hero with no matching baked loop
    expect(factoryVideo('https://cdn.example.com/custom-hero.webp')).toBeNull();
    // an unknown tier under the right folder still has no video shipped
    expect(factoryVideo('/images/polycards/mythic-factory.webp')).toBeNull();
  });
});

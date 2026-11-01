import { describe, expect, test } from 'vitest';
import {
  frameVariantFromParam,
  prizeCardUrl,
  prizeFrameVariant,
  type FrameVariant,
} from '../prize-frame';

describe('prizeFrameVariant', () => {
  test('a Lucky Draw win wears the Lucky Draw frame', () => {
    expect(prizeFrameVariant({ luckyDrawPrize: true })).toBe('lucky-draw');
  });

  test('a challenge win keeps the prism frame', () => {
    expect(prizeFrameVariant({ challengePrize: true })).toBe('prism');
  });

  test('a card pulled from a pack wears its tier, not a prize frame', () => {
    expect(prizeFrameVariant({})).toBeUndefined();
    expect(
      prizeFrameVariant({ challengePrize: false, luckyDrawPrize: false }),
    ).toBeUndefined();
  });
});

describe('the card page keeps the frame', () => {
  test.each<FrameVariant>(['prism', 'lucky-draw'])(
    '%s survives the round trip through the URL',
    (variant) => {
      const url = new URL(prizeCardUrl('a b', variant), 'https://x.test');
      expect(url.pathname).toBe('/card/a%20b');
      expect(frameVariantFromParam(url.searchParams.get('prize'))).toBe(
        variant,
      );
    },
  );

  test('an ordinary card has no marker', () => {
    expect(prizeCardUrl('mew')).toBe('/card/mew');
  });

  test('anything else in the URL means the tier frame', () => {
    expect(frameVariantFromParam(undefined)).toBeUndefined();
    expect(frameVariantFromParam('nope')).toBeUndefined();
    expect(frameVariantFromParam(['weekly'])).toBeUndefined();
  });
});

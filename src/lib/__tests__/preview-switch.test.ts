import { describe, expect, it } from 'vitest';
import { homePreviewOn, packFlowAddress, packFlowOn } from '../preview-switch';

describe('homePreviewOn: the preview switch', () => {
  it('on with HOME_PREVIEW=1 or in development, off otherwise', () => {
    expect(homePreviewOn({ NODE_ENV: 'production', HOME_PREVIEW: '1' })).toBe(
      true,
    );
    expect(homePreviewOn({ NODE_ENV: 'development' })).toBe(true);
    expect(homePreviewOn({ NODE_ENV: 'production' })).toBe(false);
    expect(
      homePreviewOn({ NODE_ENV: 'production', HOME_PREVIEW: 'true' }),
    ).toBe(false);
    expect(homePreviewOn({ NODE_ENV: 'test' })).toBe(false);
  });
});

describe('packFlowOn: whether a pack address opens the flow', () => {
  it('only with HOME_PREVIEW=1, never in development alone', () => {
    expect(packFlowOn({ NODE_ENV: 'production', HOME_PREVIEW: '1' })).toBe(
      true,
    );
    expect(packFlowOn({ NODE_ENV: 'development', HOME_PREVIEW: '1' })).toBe(
      true,
    );
    expect(packFlowOn({ NODE_ENV: 'development' })).toBe(false);
    expect(packFlowOn({ NODE_ENV: 'production' })).toBe(false);
    expect(packFlowOn({ NODE_ENV: 'production', HOME_PREVIEW: 'true' })).toBe(
      false,
    );
  });
});

describe("packFlowAddress: where a pack's own address opens under the switch", () => {
  const q = (s: string) => new URLSearchParams(s);

  it('the flow page focused on the pack', () => {
    expect(packFlowAddress('151', q(''))).toBe('/home-preview?focus=151');
  });

  it('keeps the other query, never a focus of its own', () => {
    expect(packFlowAddress('151', q('stage=3d&focus=ah'))).toBe(
      '/home-preview?stage=3d&focus=151',
    );
  });

  it('drops a key given more than once', () => {
    expect(packFlowAddress('151', q('jp=a&jp=b&stage=3d'))).toBe(
      '/home-preview?stage=3d&focus=151',
    );
  });

  it('encodes the pack id', () => {
    expect(packFlowAddress('a b&c', q(''))).toBe('/home-preview?focus=a+b%26c');
  });

  it("none for the pack page's own links (any count, even empty or repeated)", () => {
    expect(packFlowAddress('151', q('count=1'))).toBeNull();
    expect(packFlowAddress('151', q('count='))).toBeNull();
    expect(packFlowAddress('151', q('count=1&count=2'))).toBeNull();
  });
});

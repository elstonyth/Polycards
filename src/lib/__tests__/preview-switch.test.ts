import { describe, expect, it } from 'vitest';
import { homePreviewOn, packFlowAddress, packFlowOn } from '../preview-switch';
import { packPagePath } from '@/components/pack-stage/stage-focus-marks';

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
    expect(packFlowAddress('151', q('utm_source=ad&focus=ah'))).toBe(
      '/home-preview?utm_source=ad&focus=151',
    );
  });

  it('drops a key given more than once', () => {
    expect(packFlowAddress('151', q('fbclid=a&fbclid=b&utm_source=ad'))).toBe(
      '/home-preview?utm_source=ad&focus=151',
    );
  });

  it('drops the QA switches: a public pack link never carries them', () => {
    expect(
      packFlowAddress(
        '151',
        q('soldout=151&jp=151&debug=1&stage=flat&loader=never&utm_source=ad'),
      ),
    ).toBe('/home-preview?utm_source=ad&focus=151');
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

describe('packPagePath: every way back to the pack page', () => {
  const back = (id: string, search?: string) =>
    new URL(packPagePath(id, search), 'https://polycards.gg').searchParams;

  it('is never sent back to the flow (no redirect loop)', () => {
    for (const id of ['151', 'a b&c']) {
      expect(packFlowAddress(id, back(id))).toBeNull();
      expect(
        packFlowAddress(id, back(id, '?utm_source=ad&focus=x')),
      ).toBeNull();
    }
  });

  it("keeps the visitor's query, minus the focus", () => {
    expect(packPagePath('151')).toBe('/slots/151?count=1');
    expect(packPagePath('a b&c')).toBe('/slots/a%20b%26c?count=1');
    expect(packPagePath('151', '?fbclid=x&focus=151&count=3')).toBe(
      '/slots/151?fbclid=x&count=1',
    );
  });
});

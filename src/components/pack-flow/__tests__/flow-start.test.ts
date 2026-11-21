import { describe, expect, it } from 'vitest';
import { flowStart, homePreviewOn } from '../flow-start';

const pack = (id: string) => ({ id });
const categories = [
  { id: 'pokemon', packs: [pack('151'), pack('ah'), pack('gold-pack')] },
  { id: 'poly', packs: [pack('lucky-pack')] },
  { id: 'one-piece', packs: [pack('op-01')] },
];
const tabs = [
  { id: 'pokemon', soon: false },
  { id: 'poly', soon: false },
  { id: 'one-piece', soon: true },
];
const seeds = { '151': {}, ah: {}, 'lucky-pack': {}, 'op-01': {} };

describe('flowStart: where a load onto a pack address opens the flow', () => {
  it('the pack, in its own tab, at its place in the row', () => {
    expect(flowStart({ categories, tabs, seeds, id: 'ah' })).toEqual({
      category: 'pokemon',
      index: 1,
    });
    expect(flowStart({ categories, tabs, seeds, id: 'lucky-pack' })).toEqual({
      category: 'poly',
      index: 0,
    });
  });

  it('none for a pack not in the catalogue (unknown or inactive)', () => {
    expect(flowStart({ categories, tabs, seeds, id: 'nope' })).toBeNull();
  });

  it('none for a pack with nothing to focus (no starting data)', () => {
    expect(flowStart({ categories, tabs, seeds, id: 'gold-pack' })).toBeNull();
  });

  it('none for a pack in a tab that cannot be picked', () => {
    expect(flowStart({ categories, tabs, seeds, id: 'op-01' })).toBeNull();
  });
});

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

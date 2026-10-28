import { describe, expect, it } from 'vitest';
import i18next from 'i18next';
import en from './en.json';

// Counts on the finance pages pass `count` for plurals and print it through
// i18next's built-in number formatter, so 2163 reads "2,163".
describe('finance page counts', () => {
  it('read with thousands separators and keep their plurals', async () => {
    const i = i18next.createInstance();
    await i.init({
      lng: 'en',
      resources: { en: { translation: en } },
      interpolation: { escapeValue: false },
    });
    expect(i.t('settlement.topupsCount', { count: 1506 })).toBe(
      '1,506 top-ups',
    );
    expect(i.t('settlement.topupsCount', { count: 1 })).toBe('1 top-up');
    expect(i.t('settlement.payoutsCount', { count: 1200 })).toBe(
      '1,200 payouts',
    );
    expect(
      i.t('profit.cardsNoTopupNote', { count: 2163, value: 'RM 1.00' }),
    ).toBe('Not counted: 2,163 cards (RM 1.00) of players who never topped up');
    expect(i.t('profit.cardsNote', { count: 1314, delivering: 63 })).toBe(
      '1,314 cards, 63 being shipped',
    );
    expect(i.t('settlement.findingsBar', { count: 1419 })).toBe(
      '1,419 payments the gateway disagrees with',
    );
    expect(i.t('settlement.checkDiffers', { count: 1419 })).toBe(
      '⚠ 1,419 payments differ',
    );
  });
});

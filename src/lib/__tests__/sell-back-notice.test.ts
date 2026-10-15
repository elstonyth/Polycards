import { describe, expect, it } from 'vitest';
import { sellBackNotice, sellOfferCopy } from '@/lib/buyback-copy';
import { toBuybackOffer } from '@/lib/actions/pack-batch-map';

// Spec 2026-10-15 (revised): the free part of a sale is for opening packs. The
// sell surfaces lack has_topup, so no variant may call money withdrawable.
describe('sellBackNotice', () => {
  it('says only what was added when nothing is held', () => {
    expect(sellBackNotice(30, 0)).toBe('RM 30.00 added.');
    expect(sellBackNotice(0, 0)).toBe('RM 0.00 added.');
  });

  it('a wholly free sale is for opening packs', () => {
    expect(sellBackNotice(20, 20)).toBe('RM 20.00 added for opening packs.');
  });

  it('names the for-packs part of a part-bonus sale', () => {
    expect(sellBackNotice(30, 10)).toBe(
      'RM 30.00 added — RM 10.00 of it for packs',
    );
  });

  it('never claims withdrawable money (a never-topped-up account included)', () => {
    for (const [amount, held] of [
      [30, 0],
      [30, 10],
      [30, 30],
    ] as const) {
      expect(sellBackNotice(amount, held).toLowerCase()).not.toContain(
        'withdraw',
      );
    }
  });

  it('rounds to the sen and clamps the held part to the sale', () => {
    expect(sellBackNotice(10, 0.004)).toBe('RM 10.00 added.');
    expect(sellBackNotice(0, 5)).toBe('RM 0.00 added.');
    expect(sellBackNotice(10, 12)).toBe('RM 10.00 added for opening packs.');
    expect(sellBackNotice(10, -1)).toBe('RM 10.00 added.');
  });
});

describe('sellOfferCopy — the reveal Sell button', () => {
  it('no held part: no second line, and the visible label names the button', () => {
    expect(sellOfferCopy(70, 70, 0)).toEqual({
      label: 'Sell for RM 70.00 (70%)',
      forPacks: null,
      ariaLabel: undefined,
    });
  });

  it('a held part gets its line and one clean accessible sentence', () => {
    const copy = sellOfferCopy(30, 90, 10);
    expect(copy.forPacks).toBe('RM 10.00 of it for packs');
    expect(copy.ariaLabel).toBe(
      'Sell for RM 30.00 (90%), RM 10.00 of it for packs',
    );
  });

  it('never names more than the offer as held', () => {
    expect(sellOfferCopy(20, 90, 25).forPacks).toBe('RM 20.00 of it for packs');
    expect(sellOfferCopy(20, 90, 0.004).forPacks).toBeNull();
  });

  it('a free-rip quote without a bonus field maps to 0 and shows no line', () => {
    const offer = toBuybackOffer({ percent: 90, amount: 27 });
    expect(offer?.bonus).toBe(0);
    expect(
      sellOfferCopy(offer!.amount, offer!.percent, offer!.bonus).forPacks,
    ).toBeNull();
  });
});

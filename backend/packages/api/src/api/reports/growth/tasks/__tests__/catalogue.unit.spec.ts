import { prizeLabel } from '../catalogue';

// The prize as the /task page words it (TaskHubClient rewardLabel), so a post
// and the page a player opens from it say the same thing.
describe('prizeLabel', () => {
  it('names a credit by its amount', () => {
    expect(prizeLabel({ type: 'credit', amount_myr: 50 })).toEqual({
      prize: 'RM 50.00 credit',
      value_myr: 50,
    });
  });

  it('names a free rip by its pack, worth the pack price', () => {
    expect(
      prizeLabel({
        type: 'pack',
        pack_id: 'silver-pack',
        pack_title: 'Silver Pack',
        pack_price_myr: 600,
        pack_image: null,
      }),
    ).toEqual({ prize: 'Free rip · Silver Pack', value_myr: 600 });
  });

  it('names a pack that is gone by its slug, marked missing for staff', () => {
    expect(
      prizeLabel({
        type: 'pack',
        pack_id: 'old-pack',
        pack_title: null,
        pack_price_myr: null,
        pack_image: null,
      }),
    ).toEqual({ prize: 'Free rip · old-pack (missing)', value_myr: null });
  });

  it('names a card with its grade, worth its display price', () => {
    expect(
      prizeLabel({
        type: 'card',
        card_handle: 'latias',
        card_name: 'Latias & Latios GX #105',
        card_grade: 'PSA 10',
        card_value_myr: 33264,
        card_image: null,
      }),
    ).toEqual({
      prize: 'Latias & Latios GX #105 · PSA 10',
      value_myr: 33264,
    });
    expect(
      prizeLabel({
        type: 'card',
        card_handle: 'raw',
        card_name: 'Raw Card',
        card_grade: null,
        card_value_myr: 12.5,
        card_image: null,
      }).prize,
    ).toBe('Raw Card');
  });

  it('says plainly when a card is gone', () => {
    expect(
      prizeLabel({
        type: 'card',
        card_handle: 'gone-card',
        card_name: null,
        card_grade: null,
        card_value_myr: null,
        card_image: null,
      }),
    ).toEqual({ prize: 'Card · gone-card (missing)', value_myr: null });
  });
});

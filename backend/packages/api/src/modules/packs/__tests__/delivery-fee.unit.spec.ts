import {
  computeDeliveryFee,
  deliveryZone,
  isEastMalaysiaPostcode,
  isShippablePostcode,
  WEST_SHIPPING_MYR,
  EAST_SHIPPING_MYR,
  PROTECTION_INCLUDED_MYR,
  INSURANCE_RATE,
} from '../delivery';

describe('isEastMalaysiaPostcode', () => {
  it('classifies Labuan/Sabah/Sarawak ranges as East', () => {
    expect(isEastMalaysiaPostcode('87000')).toBe(true); // Labuan lower edge
    expect(isEastMalaysiaPostcode('88000')).toBe(true); // Kota Kinabalu
    expect(isEastMalaysiaPostcode('93000')).toBe(true); // Kuching
    expect(isEastMalaysiaPostcode('98999')).toBe(true); // Sarawak upper edge
  });

  it('classifies peninsular ranges as West', () => {
    expect(isEastMalaysiaPostcode('50000')).toBe(false); // KL
    expect(isEastMalaysiaPostcode('86999')).toBe(false); // Johor upper edge
    expect(isEastMalaysiaPostcode('99000')).toBe(false); // above Sarawak
    expect(isEastMalaysiaPostcode('10450')).toBe(false); // Penang
  });

  it('tolerates whitespace but defaults malformed postcodes to West', () => {
    expect(isEastMalaysiaPostcode(' 93350 ')).toBe(true);
    expect(isEastMalaysiaPostcode('')).toBe(false);
    expect(isEastMalaysiaPostcode('abc')).toBe(false);
    expect(isEastMalaysiaPostcode('1234')).toBe(false); // 4 digits
    expect(isEastMalaysiaPostcode('123456')).toBe(false); // 6 digits
  });
});

describe('isShippablePostcode', () => {
  it('accepts exactly five digits, rejecting everything else', () => {
    expect(isShippablePostcode('50000')).toBe(true);
    expect(isShippablePostcode(' 88000 ')).toBe(true);
    expect(isShippablePostcode('8800')).toBe(false);
    expect(isShippablePostcode('880000')).toBe(false);
    expect(isShippablePostcode('')).toBe(false);
    expect(isShippablePostcode('KL123')).toBe(false);
    // Non-ASCII digits must not sneak past \d.
    expect(isShippablePostcode('٥٠٠٠٠')).toBe(false);
  });
});

describe('deliveryZone', () => {
  // Security review 2026-08-25 (MEDIUM): the zone used to be postcode-only, so
  // a Sabah customer could type a KL postcode and pay the West rate. The zone
  // is now the MORE EXPENSIVE of the postcode zone and the state/city zone.
  it('bills East when the postcode says East', () => {
    expect(deliveryZone('88000', null, 'Kota Kinabalu')).toBe('east');
  });

  it('bills East when the STATE says East even with a West postcode', () => {
    expect(deliveryZone('50000', 'Sabah', 'Kota Kinabalu')).toBe('east');
    expect(deliveryZone('50000', 'Sarawak', 'Kuching')).toBe('east');
    expect(deliveryZone('50000', 'W.P. Labuan', 'Labuan')).toBe('east');
    expect(deliveryZone('50000', 'SABAH', null)).toBe('east');
  });

  it('bills East when only the CITY names an East locality', () => {
    expect(deliveryZone('50000', null, 'Kuching')).toBe('east');
    expect(deliveryZone('50000', 'Selangor', 'kota kinabalu')).toBe('east');
  });

  it('bills West only when postcode AND state AND city are all West', () => {
    expect(deliveryZone('50000', 'Selangor', 'Kuala Lumpur')).toBe('west');
    expect(deliveryZone('10450', null, null)).toBe('west');
    expect(deliveryZone('40000', 'Selangor', 'Shah Alam')).toBe('west');
    expect(deliveryZone('81000', 'Johor', 'Kulai')).toBe('west');
  });

  // Every address written before the state field existed stored
  // `province = null`, and the backend stays null-tolerant on purpose. These
  // two cases pin what that means, in both directions.
  it('still zones a legacy null-province address off its East postcode', () => {
    expect(deliveryZone('88000', null, 'Kudat')).toBe('east');
    expect(deliveryZone('93000', null, null)).toBe('east');
  });

  it('zones a legacy null-province address West on an unlisted East city', () => {
    // ACCEPTED RESIDUAL, not a bug to fix here: rows created before the state
    // field carry no province, so the postcode is the only signal for them. An
    // East Malaysian town outside the twelve-name city list (Kudat, Semporna,
    // Papar, Limbang, Mukah...) combined with a West postcode bills West. It
    // closes for an address as soon as its owner edits it and picks a state;
    // closing it for the rest is a backfill over `customer_address`.
    expect(deliveryZone('50000', null, 'Semporna')).toBe('west');
    expect(deliveryZone('50000', null, 'Limbang')).toBe('west');
  });
});

describe('computeDeliveryFee', () => {
  it('charges the West rate with no insurance at or under RM200', () => {
    expect(computeDeliveryFee('50000', 200)).toEqual({
      shipping: WEST_SHIPPING_MYR,
      insurance: 0,
      total: WEST_SHIPPING_MYR,
    });
    expect(computeDeliveryFee('50000', 0)).toEqual({
      shipping: WEST_SHIPPING_MYR,
      insurance: 0,
      total: WEST_SHIPPING_MYR,
    });
  });

  it('charges the East rate for an East Malaysia postcode', () => {
    expect(computeDeliveryFee('88000', 150)).toEqual({
      shipping: EAST_SHIPPING_MYR,
      insurance: 0,
      total: EAST_SHIPPING_MYR,
    });
  });

  it('adds mandatory 5% insurance on the FULL value above RM200', () => {
    // RM500 order: insurance = 5% of 500 = RM25, not 5% of the RM300 excess.
    expect(computeDeliveryFee('50000', 500)).toEqual({
      shipping: WEST_SHIPPING_MYR,
      insurance: 25,
      total: 40,
    });
    expect(computeDeliveryFee('93000', 500)).toEqual({
      shipping: EAST_SHIPPING_MYR,
      insurance: 25,
      total: 60,
    });
  });

  it('kicks in strictly above the threshold', () => {
    expect(computeDeliveryFee('50000', PROTECTION_INCLUDED_MYR).insurance).toBe(
      0,
    );
    expect(
      computeDeliveryFee('50000', PROTECTION_INCLUDED_MYR + 0.01).insurance,
    ).toBeCloseTo((PROTECTION_INCLUDED_MYR + 0.01) * INSURANCE_RATE, 2);
  });

  it('rounds insurance and total to cents', () => {
    // 5% of 333.33 = 16.6665 -> 16.67
    const fee = computeDeliveryFee('50000', 333.33);
    expect(fee.insurance).toBe(16.67);
    expect(fee.total).toBe(31.67);
  });
});

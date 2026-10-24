import { describe, expect, it } from 'vitest';
import {
  computeDeliveryFee,
  computeParcelFee,
  deliveryZone,
  isEastMalaysiaPostcode,
  isShippablePostcode,
  EAST_SHIPPING_MYR,
  WEST_SHIPPING_MYR,
  isShippableCountry,
  postcodeHint,
} from '../delivery-fee';
import { MY_STATES, stateAfterCountryChange, statesFor } from '@/lib/my-states';

// Singapore (2026-10-14): shipped direct, flat RM50 — mirrors the backend.
describe('Singapore delivery', () => {
  it('ships to Malaysia and Singapore only', () => {
    expect(isShippableCountry('MY')).toBe(true);
    expect(isShippableCountry('sg')).toBe(true);
    expect(isShippableCountry('TH')).toBe(false);
  });

  it('wants 6 digits for Singapore, 5 for Malaysia', () => {
    expect(isShippablePostcode('018983', 'SG')).toBe(true);
    expect(isShippablePostcode('18983', 'SG')).toBe(false);
    expect(isShippablePostcode('50450', 'MY')).toBe(true);
    expect(postcodeHint('SG')).toMatch(/6-digit Singapore/);
    expect(postcodeHint('MY')).toMatch(/5-digit Malaysian/);
  });

  it('zones and prices Singapore at RM50, the dearer reading winning', () => {
    expect(deliveryZone('018983', null, 'Singapore', 'SG')).toBe('sg');
    expect(deliveryZone('50450', null, 'Singapore', 'MY')).toBe('sg');
    expect(computeDeliveryFee('018983', 100, null, 'Singapore', 'SG')).toEqual({
      shipping: 50,
      insurance: 0,
      total: 50,
    });
  });

  it('offers Singapore as the only "state" for a Singapore address', () => {
    expect(statesFor('SG')).toEqual(['Singapore']);
    expect(statesFor('MY')).toBe(MY_STATES);
    expect(statesFor('')).toBe(MY_STATES);
  });

  it('fills in Singapore and clears a state from the other country', () => {
    expect(stateAfterCountryChange('SG', '')).toBe('Singapore');
    expect(stateAfterCountryChange('SG', 'Selangor')).toBe('Singapore');
    expect(stateAfterCountryChange('MY', 'Singapore')).toBe('');
    expect(stateAfterCountryChange('MY', 'Selangor')).toBe('Selangor');
  });
});

// Mirror of the backend spec (delivery-fee.unit.spec.ts) — keeps the client
// preview honest against the authoritative backend charge.
describe('isEastMalaysiaPostcode', () => {
  it('East ranges: Labuan/Sabah/Sarawak', () => {
    for (const p of ['87000', '88000', '91999', '93000', '98999']) {
      expect(isEastMalaysiaPostcode(p)).toBe(true);
    }
  });
  it('West and malformed default to West', () => {
    for (const p of ['50000', '86999', '99000', '', 'abc', '1234']) {
      expect(isEastMalaysiaPostcode(p)).toBe(false);
    }
  });
});

describe('isShippablePostcode', () => {
  it('accepts five digits only', () => {
    expect(isShippablePostcode('50000')).toBe(true);
    expect(isShippablePostcode(' 88000 ')).toBe(true);
    for (const p of ['8800', '880000', '', 'KL123', '٥٠٠٠٠']) {
      expect(isShippablePostcode(p)).toBe(false);
    }
  });
});

describe('deliveryZone', () => {
  // Mirrors the backend rule: the preview must show East for a Sabah address
  // even when the customer typed a West postcode, or it would promise RM15
  // and the request would charge RM35.
  it('takes the more expensive of postcode and state/city', () => {
    expect(deliveryZone('88000', null, 'Kota Kinabalu')).toBe('east');
    expect(deliveryZone('50000', 'Sabah', 'Kota Kinabalu')).toBe('east');
    expect(deliveryZone('50000', null, 'Kuching')).toBe('east');
    expect(deliveryZone('50000', 'Selangor', 'Kuala Lumpur')).toBe('west');
  });

  // Kept symmetric with delivery-fee.unit.spec.ts: addresses written before the
  // state field stored `province = null`, and both sides stay null-tolerant.
  it('still zones a legacy null-province address off its East postcode', () => {
    expect(deliveryZone('88000', null, 'Kudat')).toBe('east');
    expect(deliveryZone('93000', null, null)).toBe('east');
  });

  it('zones a legacy null-province address West on an unlisted East city', () => {
    // ACCEPTED RESIDUAL: with no province, the postcode is the only signal, so
    // an East town outside the twelve-name city list previews West. Closes per
    // address when its owner edits it and picks a state.
    expect(deliveryZone('50000', null, 'Semporna')).toBe('west');
    expect(deliveryZone('50000', null, 'Limbang')).toBe('west');
  });

  // The three East spellings in MY_STATES are load-bearing money logic: the
  // select writes them verbatim into `province`, so each must zone East.
  it('zones East for every East entry the State select can produce', () => {
    for (const state of ['Sabah', 'Sarawak', 'W.P. Labuan']) {
      expect(deliveryZone('50000', state, 'Kuala Lumpur')).toBe('east');
    }
    for (const state of MY_STATES.filter(
      (s) => !['Sabah', 'Sarawak', 'W.P. Labuan'].includes(s),
    )) {
      expect(deliveryZone('50000', state, 'Shah Alam')).toBe('west');
    }
  });
});

describe('computeDeliveryFee', () => {
  it('no insurance at or under RM200', () => {
    expect(computeDeliveryFee('50000', 200)).toEqual({
      shipping: WEST_SHIPPING_MYR,
      insurance: 0,
      total: WEST_SHIPPING_MYR,
    });
  });
  it('mandatory 5% of the FULL value above RM200', () => {
    expect(computeDeliveryFee('93000', 500)).toEqual({
      shipping: EAST_SHIPPING_MYR,
      insurance: 25,
      total: 60,
    });
  });

  it('bills the East rate for an East state carrying a West postcode', () => {
    expect(computeDeliveryFee('50000', 100, 'Sabah', 'Kota Kinabalu')).toEqual({
      shipping: EAST_SHIPPING_MYR,
      insurance: 0,
      total: EAST_SHIPPING_MYR,
    });
  });
  it('rounds to cents', () => {
    expect(computeDeliveryFee('50000', 333.33)).toEqual({
      shipping: WEST_SHIPPING_MYR,
      insurance: 16.67,
      total: 31.67,
    });
  });
});

// Mirror of the backend computeParcelFee spec (2026-10-23): one parcel, one
// shipping fee; insurance as separate orders charged it.
describe('computeParcelFee', () => {
  it('charges one zone fee for vault cards plus prize cards', () => {
    expect(computeParcelFee('50000', 120, [80])).toEqual({
      shipping: WEST_SHIPPING_MYR,
      insurance: 0,
      total: WEST_SHIPPING_MYR,
    });
  });

  it('insures the vault cards together and each prize on its own value', () => {
    expect(computeParcelFee('50000', 190, [190]).insurance).toBe(0);
    expect(computeParcelFee('50000', 250, [300, 100])).toEqual({
      shipping: 15,
      insurance: 27.5,
      total: 42.5,
    });
  });
});

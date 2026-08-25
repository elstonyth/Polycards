import { describe, expect, it } from 'vitest';
import {
  computeDeliveryFee,
  deliveryZone,
  isEastMalaysiaPostcode,
  isShippablePostcode,
  EAST_SHIPPING_MYR,
  WEST_SHIPPING_MYR,
} from '../delivery-fee';

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

import {
  computeDeliveryFee,
  isEastMalaysiaPostcode,
  WEST_SHIPPING_MYR,
  EAST_SHIPPING_MYR,
  PROTECTION_INCLUDED_MYR,
  INSURANCE_RATE,
} from "../delivery";

describe("isEastMalaysiaPostcode", () => {
  it("classifies Labuan/Sabah/Sarawak ranges as East", () => {
    expect(isEastMalaysiaPostcode("87000")).toBe(true); // Labuan lower edge
    expect(isEastMalaysiaPostcode("88000")).toBe(true); // Kota Kinabalu
    expect(isEastMalaysiaPostcode("93000")).toBe(true); // Kuching
    expect(isEastMalaysiaPostcode("98999")).toBe(true); // Sarawak upper edge
  });

  it("classifies peninsular ranges as West", () => {
    expect(isEastMalaysiaPostcode("50000")).toBe(false); // KL
    expect(isEastMalaysiaPostcode("86999")).toBe(false); // Johor upper edge
    expect(isEastMalaysiaPostcode("99000")).toBe(false); // above Sarawak
    expect(isEastMalaysiaPostcode("10450")).toBe(false); // Penang
  });

  it("tolerates whitespace but defaults malformed postcodes to West", () => {
    expect(isEastMalaysiaPostcode(" 93350 ")).toBe(true);
    expect(isEastMalaysiaPostcode("")).toBe(false);
    expect(isEastMalaysiaPostcode("abc")).toBe(false);
    expect(isEastMalaysiaPostcode("1234")).toBe(false); // 4 digits
    expect(isEastMalaysiaPostcode("123456")).toBe(false); // 6 digits
  });
});

describe("computeDeliveryFee", () => {
  it("charges the West rate with no insurance at or under RM200", () => {
    expect(computeDeliveryFee("50000", 200)).toEqual({
      shipping: WEST_SHIPPING_MYR,
      insurance: 0,
      total: WEST_SHIPPING_MYR,
    });
    expect(computeDeliveryFee("50000", 0)).toEqual({
      shipping: WEST_SHIPPING_MYR,
      insurance: 0,
      total: WEST_SHIPPING_MYR,
    });
  });

  it("charges the East rate for an East Malaysia postcode", () => {
    expect(computeDeliveryFee("88000", 150)).toEqual({
      shipping: EAST_SHIPPING_MYR,
      insurance: 0,
      total: EAST_SHIPPING_MYR,
    });
  });

  it("adds mandatory 5% insurance on the FULL value above RM200", () => {
    // RM500 order: insurance = 5% of 500 = RM25, not 5% of the RM300 excess.
    expect(computeDeliveryFee("50000", 500)).toEqual({
      shipping: WEST_SHIPPING_MYR,
      insurance: 25,
      total: 40,
    });
    expect(computeDeliveryFee("93000", 500)).toEqual({
      shipping: EAST_SHIPPING_MYR,
      insurance: 25,
      total: 60,
    });
  });

  it("kicks in strictly above the threshold", () => {
    expect(computeDeliveryFee("50000", PROTECTION_INCLUDED_MYR).insurance).toBe(0);
    expect(
      computeDeliveryFee("50000", PROTECTION_INCLUDED_MYR + 0.01).insurance,
    ).toBeCloseTo((PROTECTION_INCLUDED_MYR + 0.01) * INSURANCE_RATE, 2);
  });

  it("rounds insurance and total to cents", () => {
    // 5% of 333.33 = 16.6665 -> 16.67
    const fee = computeDeliveryFee("50000", 333.33);
    expect(fee.insurance).toBe(16.67);
    expect(fee.total).toBe(31.67);
  });
});

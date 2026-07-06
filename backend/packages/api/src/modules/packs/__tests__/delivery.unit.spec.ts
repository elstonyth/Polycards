import type { HttpTypes } from "@medusajs/types";
import {
  validateDeliveryRequest,
  validateDeliveryStatusTransition,
  snapshotAddress,
  DELIVERY_STATUSES,
} from "../delivery";

describe("validateDeliveryRequest", () => {
  const caller = "cus_1";
  const vaulted = (id: string, customer_id = caller) => ({
    id,
    customer_id,
    status: "vaulted" as const,
  });

  it("returns ok when every requested pull is owned and vaulted", () => {
    const pulls = [vaulted("p1"), vaulted("p2")];
    expect(validateDeliveryRequest(pulls, ["p1", "p2"], caller)).toBe("ok");
  });

  it("rejects an empty selection", () => {
    expect(validateDeliveryRequest([], [], caller)).toBe("empty");
  });

  it("rejects when a requested id is missing from the fetched pulls", () => {
    expect(validateDeliveryRequest([vaulted("p1")], ["p1", "p2"], caller)).toBe(
      "not_found",
    );
  });

  it("rejects a pull owned by someone else (no existence leak)", () => {
    const pulls = [vaulted("p1"), vaulted("p2", "cus_2")];
    expect(validateDeliveryRequest(pulls, ["p1", "p2"], caller)).toBe(
      "forbidden",
    );
  });

  it("rejects a pull that is not vaulted (already delivering/sold)", () => {
    const pulls = [
      vaulted("p1"),
      { id: "p2", customer_id: caller, status: "delivering" as const },
    ];
    expect(validateDeliveryRequest(pulls, ["p1", "p2"], caller)).toBe(
      "not_vaulted",
    );
  });

  it("rejects duplicate ids in the selection", () => {
    expect(validateDeliveryRequest([vaulted("p1")], ["p1", "p1"], caller)).toBe(
      "duplicate",
    );
  });

  describe("reward-source gate", () => {
    it("rejects reward pulls (they ship via the rewards withdrawal path)", () => {
      const pulls = [{ ...vaulted("p1"), source: "reward" }];
      expect(validateDeliveryRequest(pulls, ["p1"], caller)).toBe("reward_source");
    });

    it("accepts pack pulls (source pack / undefined)", () => {
      const packPull = { ...vaulted("p1"), source: "pack" };
      expect(validateDeliveryRequest([packPull], ["p1"], caller)).toBe("ok");

      const noPull = vaulted("p1");
      expect(validateDeliveryRequest([noPull], ["p1"], caller)).toBe("ok");
    });
  });
});

describe("validateDeliveryStatusTransition", () => {
  it("allows requested → packing", () => {
    expect(validateDeliveryStatusTransition("requested", "packing", false)).toBe(
      "ok",
    );
  });

  it("requires tracking for packing → shipped", () => {
    expect(validateDeliveryStatusTransition("packing", "shipped", false)).toBe(
      "tracking_required",
    );
    expect(validateDeliveryStatusTransition("packing", "shipped", true)).toBe(
      "ok",
    );
  });

  it("allows shipped → delivered", () => {
    expect(validateDeliveryStatusTransition("shipped", "delivered", true)).toBe(
      "ok",
    );
  });

  it("allows cancel only before shipping", () => {
    expect(validateDeliveryStatusTransition("requested", "canceled", false)).toBe(
      "ok",
    );
    expect(validateDeliveryStatusTransition("packing", "canceled", false)).toBe(
      "ok",
    );
    expect(validateDeliveryStatusTransition("shipped", "canceled", true)).toBe(
      "invalid_transition",
    );
  });

  it("rejects skips and moves out of terminal states", () => {
    expect(validateDeliveryStatusTransition("requested", "shipped", true)).toBe(
      "invalid_transition",
    );
    expect(validateDeliveryStatusTransition("delivered", "shipped", true)).toBe(
      "invalid_transition",
    );
    expect(validateDeliveryStatusTransition("canceled", "packing", false)).toBe(
      "invalid_transition",
    );
  });

  it("rejects a no-op transition to the same status", () => {
    expect(validateDeliveryStatusTransition("packing", "packing", false)).toBe(
      "invalid_transition",
    );
  });
});

describe("snapshotAddress", () => {
  it("maps a Medusa address to the order snapshot fields", () => {
    const addr = {
      first_name: "Ada",
      last_name: "Lovelace",
      address_1: "1 Analytical Way",
      address_2: "Apt 2",
      city: "London",
      province: null,
      postal_code: "EC1",
      country_code: "gb",
      phone: "555",
    } as HttpTypes.StoreCustomerAddress;
    expect(snapshotAddress(addr)).toEqual({
      ship_name: "Ada Lovelace",
      ship_address_1: "1 Analytical Way",
      ship_address_2: "Apt 2",
      ship_city: "London",
      ship_province: null,
      ship_postal_code: "EC1",
      ship_country_code: "gb",
      ship_phone: "555",
    });
  });

  it("returns null when a required field is missing", () => {
    expect(
      snapshotAddress({ first_name: "Ada" } as HttpTypes.StoreCustomerAddress),
    ).toBeNull();
  });
});

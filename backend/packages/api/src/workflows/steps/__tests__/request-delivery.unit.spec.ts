import { MedusaError } from "@medusajs/framework/utils";
import { verdictError } from "../request-delivery";

// Sim P3 #9: a double-submit of a delivery request used to 400 with "no longer
// available to deliver" — technically true, but it reads as if the cards
// vanished. Each blocking status now gets an accurate customer-facing message.
describe("verdictError", () => {
  it("names the double-submit case: cards already in a delivery", () => {
    const err = verdictError("already_delivering");
    expect(err.type).toBe(MedusaError.Types.NOT_ALLOWED);
    expect(err.message).toBe(
      "One or more cards are already in a pending delivery request.",
    );
  });

  it("names the already-delivered case", () => {
    const err = verdictError("already_delivered");
    expect(err.type).toBe(MedusaError.Types.NOT_ALLOWED);
    expect(err.message).toBe(
      "One or more cards have already been delivered.",
    );
  });

  it("names the sold-back case", () => {
    const err = verdictError("bought_back");
    expect(err.type).toBe(MedusaError.Types.NOT_ALLOWED);
    expect(err.message).toBe(
      "One or more cards were already sold back.",
    );
  });

  it("keeps the generic message for an unrecognized non-vaulted status", () => {
    const err = verdictError("not_vaulted");
    expect(err.type).toBe(MedusaError.Types.NOT_ALLOWED);
    expect(err.message).toBe(
      "One or more cards are no longer available to deliver.",
    );
  });

  // No-leak pin: unknown id and someone else's pull MUST stay indistinguishable.
  it("maps not_found and forbidden to the identical 404", () => {
    const notFound = verdictError("not_found");
    const forbidden = verdictError("forbidden");
    expect(notFound.type).toBe(MedusaError.Types.NOT_FOUND);
    expect(forbidden.type).toBe(MedusaError.Types.NOT_FOUND);
    expect(forbidden.message).toBe(notFound.message);
  });
});

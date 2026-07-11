import type {
  MedusaNextFunction,
  MedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import { MedusaError } from "@medusajs/framework/utils";
import { validateDeliverableAddress } from "../address-guard";

// Sim finding P3-8: Medusa's stock create-address route 200s an address with
// null country_code AND null postal_code — silently undeliverable. The guard
// rejects those before the core route runs.

const makeReq = (body: unknown): MedusaRequest =>
  ({ body }) as unknown as MedusaRequest;

const res = {} as MedusaResponse;

const run = (mode: "create" | "update", body: unknown): unknown => {
  const mw = validateDeliverableAddress(mode);
  let err: unknown;
  const next = ((e?: unknown) => {
    err = e;
  }) as MedusaNextFunction;
  mw(makeReq(body), res, next);
  return err;
};

const GOOD = {
  first_name: "A",
  address_1: "1 Sim St",
  city: "KL",
  country_code: "my",
  postal_code: "50000",
};

describe("validateDeliverableAddress (create)", () => {
  it("passes a complete deliverable address through", () => {
    expect(run("create", GOOD)).toBeUndefined();
  });

  it.each([
    ["null country_code", { ...GOOD, country_code: null }],
    ["missing country_code", { ...GOOD, country_code: undefined }],
    ["empty country_code", { ...GOOD, country_code: "" }],
    ["whitespace country_code", { ...GOOD, country_code: "  " }],
    ["null postal_code", { ...GOOD, postal_code: null }],
    ["missing postal_code", { ...GOOD, postal_code: undefined }],
    ["empty postal_code", { ...GOOD, postal_code: "" }],
    ["non-string postal_code", { ...GOOD, postal_code: 50000 }],
    ["both null", { ...GOOD, country_code: null, postal_code: null }],
    ["empty body", {}],
    ["no body", undefined],
  ])("rejects %s with INVALID_DATA", (_label, body) => {
    const err = run("create", body);
    expect(err).toBeInstanceOf(MedusaError);
    expect((err as MedusaError).type).toBe(MedusaError.Types.INVALID_DATA);
    expect((err as MedusaError).message).toMatch(/country and postal code/i);
  });
});

describe("validateDeliverableAddress (update)", () => {
  it("allows a partial update that does not touch the guarded fields", () => {
    expect(run("update", { city: "Penang" })).toBeUndefined();
  });

  it("allows a partial update that sets valid guarded fields", () => {
    expect(
      run("update", { country_code: "my", postal_code: "10000" }),
    ).toBeUndefined();
  });

  it.each([
    ["explicit null country_code", { country_code: null }],
    ["empty country_code", { country_code: "" }],
    ["explicit null postal_code", { postal_code: null }],
    ["whitespace postal_code", { postal_code: " " }],
  ])("rejects %s (cannot blank out a deliverable field)", (_label, body) => {
    const err = run("update", body);
    expect(err).toBeInstanceOf(MedusaError);
    expect((err as MedusaError).type).toBe(MedusaError.Types.INVALID_DATA);
  });
});

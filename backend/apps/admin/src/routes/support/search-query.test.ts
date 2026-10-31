import { describe, expect, it } from "vitest";
import { supportSearchQuery } from "./search-query";

describe("supportSearchQuery", () => {
  it.each([
    ["+60 12-345 6789", "+60123456789"],
    ["012-345 6789", "0123456789"],
    ["(012) 345-6789", "0123456789"],
    ["  8123 4567 ", "81234567"],
  ])("strips the separators from the phone %s", (raw, expected) => {
    expect(supportSearchQuery(raw)).toBe(expected);
  });

  it.each([
    ["  Ah Beng ", "Ah Beng"],
    ["mary-jane@example.com", "mary-jane@example.com"],
    ["@Collector8011", "@Collector8011"],
  ])("leaves %s as typed, only trimmed", (raw, expected) => {
    expect(supportSearchQuery(raw)).toBe(expected);
  });
});

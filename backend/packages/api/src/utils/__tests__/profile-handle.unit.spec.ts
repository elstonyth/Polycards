import {
  USERNAME_MAX,
  USERNAME_RE,
  generatedUsername,
  isValidUsername,
  normalizeUsername,
  publicProfileFields,
  sanitizeUsername,
  suffixedUsername,
} from "../profile-handle";

// A customer's display name IS their public profile URL. These rules are what
// makes that safe: a fixed ASCII charset so a name is a URL segment without
// encoding, and a case fold so two people can never hold what reads as one
// link. Nothing here is derived or stored separately — that was the old model,
// and it silently orphaned every URL on rename.

describe("USERNAME_RE", () => {
  it("accepts the shapes real display names take", () => {
    expect("MOONBREON").toMatch(USERNAME_RE); // uppercase is a DISPLAY name
    expect("ash_red").toMatch(USERNAME_RE);
    expect("EvOlViNg_CrIeS").toMatch(USERNAME_RE);
    expect("Wei-Nguan").toMatch(USERNAME_RE);
    expect("Collector4809").toMatch(USERNAME_RE);
  });

  it("rejects anything that would not survive a URL intact", () => {
    expect("has space").not.toMatch(USERNAME_RE);
    expect("爱动漫的").not.toMatch(USERNAME_RE);
    expect("semi;colon").not.toMatch(USERNAME_RE);
    expect("slash/es").not.toMatch(USERNAME_RE);
    expect("per%cent").not.toMatch(USERNAME_RE);
    expect("ab").not.toMatch(USERNAME_RE); // too short
    expect("x".repeat(USERNAME_MAX + 1)).not.toMatch(USERNAME_RE);
  });
});

describe("normalizeUsername", () => {
  it("folds case and trims — the one comparison key", () => {
    expect(normalizeUsername("  MOONBREON ")).toBe("moonbreon");
    expect(normalizeUsername("Moonbreon")).toBe(normalizeUsername("MOONBREON"));
  });
});

describe("isValidUsername", () => {
  it("tolerates surrounding whitespace but not internal", () => {
    expect(isValidUsername("  Kenji  ")).toBe(true);
    expect(isValidUsername("Ke nji")).toBe(false);
    expect(isValidUsername(null)).toBe(false);
    expect(isValidUsername(42)).toBe(false);
  });
});

describe("sanitizeUsername", () => {
  it("coerces a human name into the charset", () => {
    expect(sanitizeUsername("Wei Nguan")).toBe("Wei_Nguan");
    expect(sanitizeUsername("Mira O'Neill")).toBe("Mira_O_Neill");
    expect(sanitizeUsername("  dope tcg collectibles ")).toBe(
      "dope_tcg_collectibles",
    );
  });

  it("returns null when nothing usable survives", () => {
    expect(sanitizeUsername("爱动漫的")).toBeNull(); // no ASCII at all
    expect(sanitizeUsername("")).toBeNull();
    expect(sanitizeUsername(null)).toBeNull();
    expect(sanitizeUsername("__")).toBeNull(); // separators only
    expect(sanitizeUsername("ab")).toBeNull(); // under the minimum
  });

  it("never emits something the write gate would then reject", () => {
    for (const raw of [
      "Wei Nguan",
      "x".repeat(200),
      "!!!alpha!!!",
      "a b c d e f g h i j k l m n o p q r s t",
    ]) {
      const out = sanitizeUsername(raw);
      if (out !== null) expect(out).toMatch(USERNAME_RE);
    }
  });
});

describe("generatedUsername", () => {
  it("is deterministic per customer and looks like any other name", () => {
    expect(generatedUsername("cus_01ABCDEF")).toBe(
      generatedUsername("cus_01ABCDEF"),
    );
    expect(generatedUsername("cus_01ABCDEF")).toMatch(USERNAME_RE);
    expect(generatedUsername("cus_01ABCDEF")).toMatch(/^Collector\d{4}$/);
  });
});

describe("suffixedUsername", () => {
  it("varies with the attempt so a retry is a NEW candidate", () => {
    const a = suffixedUsername("Tan", "cus_1", 0);
    const b = suffixedUsername("Tan", "cus_1", 1);
    expect(a).not.toBe(b);
    expect(a).toBe(suffixedUsername("Tan", "cus_1", 0)); // deterministic
  });

  it("keeps the stem readable", () => {
    expect(suffixedUsername("Tan", "cus_1", 0)).toMatch(/^Tan\d{4}$/);
  });

  it("truncates a long stem instead of overflowing the limit", () => {
    // The regression this guards: appending blindly produces a candidate the
    // write gate rejects, turning a name collision into a 500.
    const out = suffixedUsername("x".repeat(USERNAME_MAX), "cus_1", 0);
    expect(out.length).toBeLessThanOrEqual(USERNAME_MAX);
    expect(out).toMatch(USERNAME_RE);
  });

  it("never leaves a trailing separator where it cut", () => {
    const out = suffixedUsername(`${"a".repeat(25)}___________`, "cus_1", 0);
    expect(out).toMatch(USERNAME_RE);
    expect(out).not.toMatch(/[_-]\d{4}$/);
  });
});

describe("publicProfileFields", () => {
  it("uses the display name as the handle", () => {
    expect(
      publicProfileFields({ first_name: "MOONBREON", metadata: {} }, 12345),
    ).toEqual({ name: "MOONBREON", handle: "MOONBREON", avatarUrl: null });
  });

  it("returns no handle when the name could not be a URL", () => {
    // A row written before the backfill must degrade to "no link", never to a
    // link that 404s.
    const { name, handle } = publicProfileFields(
      { first_name: "爱动漫的", metadata: {} },
      98765,
    );
    expect(name).toBe("爱动漫的");
    expect(handle).toBeNull();
  });

  it("anonymises a nameless customer and links nothing", () => {
    expect(publicProfileFields(undefined, 98765)).toEqual({
      name: "Collector 9876",
      handle: null,
      avatarUrl: null,
    });
  });

  it("passes through a stored avatar url", () => {
    expect(
      publicProfileFields(
        { first_name: "Kenji", metadata: { avatar_url: "/a.webp" } },
        1,
      ).avatarUrl,
    ).toBe("/a.webp");
  });
});
